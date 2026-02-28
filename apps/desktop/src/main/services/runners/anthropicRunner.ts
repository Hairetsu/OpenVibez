import { spawn } from 'node:child_process';
import path from 'node:path';
import type { WorkspaceRow } from '../db';
import { createAnthropicCompletion, createAnthropicToolTurn } from '../providers/anthropic';
import { enforceCommandPolicy } from './commandPolicy';
import { resolveAnthropicModel } from './models';
import type { ProviderRunner } from './types';

const ANTHROPIC_TOOL_CALL_PREFIX = 'TOOL_CALL';
const ANTHROPIC_PLAN_PREFIX = 'PLAN';
const ANTHROPIC_STEP_DONE_PREFIX = 'STEP_DONE';
const ANTHROPIC_FINAL_PREFIX = 'FINAL';
const MAX_ANTHROPIC_TOOL_STEPS = 24;
const MAX_ANTHROPIC_PLAN_STEPS = 12;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_LIMIT = 20_000;

class RequestCancelledError extends Error {
  constructor(message = 'Request cancelled by user.') {
    super(message);
    this.name = 'AbortError';
  }
}

class NativeToolFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeToolFallbackError';
  }
}

type AnthropicToolCall = {
  name: 'run_shell';
  arguments: {
    command: string;
    cwd?: string;
  };
};

type AnthropicExecutionPlan = {
  steps: string[];
};

type AnthropicStepDone = {
  index: number;
  note?: string;
};

type AnthropicFinal = { message: string };

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Unknown error';
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new RequestCancelledError();
  }
};

const buildAnthropicToolSystemPrompt = (input: {
  accessMode: 'scoped' | 'root';
  workspacePath?: string;
  trustLevel?: 'trusted' | 'read_only' | 'untrusted';
}): string => {
  const context = input.workspacePath
    ? `Preferred working directory: ${input.workspacePath}`
    : 'No workspace directory is selected.';

  const trust = input.trustLevel ? `Workspace trust: ${input.trustLevel}.` : 'Workspace trust: none.';

  return [
    'You are OpenVibez Anthropic coding assistant with autonomous CLI tool access.',
    '',
    'You MUST follow this protocol:',
    `1) First response: ${ANTHROPIC_PLAN_PREFIX} {"steps":["step 1","step 2",...]}`,
    `2) During execution: respond with either ${ANTHROPIC_TOOL_CALL_PREFIX} {...} or ${ANTHROPIC_STEP_DONE_PREFIX} {"index":<1-based>,"note":"optional"}`,
    `3) Only when every step is completed: ${ANTHROPIC_FINAL_PREFIX} {"message":"final user response"}`,
    '',
    'Never claim a step is complete unless command output verified it.',
    `When you need to execute a shell command, respond with exactly one line:`,
    `${ANTHROPIC_TOOL_CALL_PREFIX} {"name":"run_shell","arguments":{"command":"<shell command>","cwd":"<optional cwd>"}}`,
    'No markdown and no extra text when calling a tool.',
    '',
    'Available tools:',
    '- run_shell(command: string, cwd?: string): run a shell command and return stdout, stderr, exit code, and timeout info.',
    '',
    'Use tools whenever they help fulfill the request. You may call tools repeatedly until done.',
    'Do not stop early. Before finalizing, verify key outputs exist by running shell checks.',
    `Only return ${ANTHROPIC_FINAL_PREFIX} after all planned steps are complete.`,
    `Access mode: ${input.accessMode}.`,
    trust,
    context,
    'After tool results are returned, either call another tool, mark a step complete, or finalize if everything is done.'
  ].join('\n');
};

const parsePrefixedJson = (text: string, prefix: string): unknown | null => {
  const trimmed = text.trim();
  const prefixIndex = trimmed.indexOf(prefix);
  if (prefixIndex === -1) {
    return null;
  }

  const payloadText = trimmed.slice(prefixIndex + prefix.length).trim();
  if (!payloadText) {
    return null;
  }

  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
};

const sanitizePlanSteps = (steps: string[]): string[] => {
  const cleaned = steps
    .map((step) => step.trim())
    .filter((step, index, list) => step.length > 0 && list.indexOf(step) === index);

  if (cleaned.length === 0) {
    return ['Complete the user request end-to-end.'];
  }

  return cleaned.slice(0, MAX_ANTHROPIC_PLAN_STEPS);
};

const parseAnthropicPlan = (text: string): AnthropicExecutionPlan | null => {
  const payload = parsePrefixedJson(text, ANTHROPIC_PLAN_PREFIX) as { steps?: unknown } | null;
  if (!payload || !Array.isArray(payload.steps)) {
    return null;
  }

  const steps = sanitizePlanSteps(payload.steps.filter((entry): entry is string => typeof entry === 'string'));
  return { steps };
};

const parseAnthropicToolCall = (text: string): AnthropicToolCall | null => {
  const payload = parsePrefixedJson(text, ANTHROPIC_TOOL_CALL_PREFIX) as {
    name?: unknown;
    arguments?: { command?: unknown; cwd?: unknown };
  } | null;
  if (!payload || payload.name !== 'run_shell') {
    return null;
  }

  const command = typeof payload.arguments?.command === 'string' ? payload.arguments.command.trim() : '';
  if (!command) {
    return null;
  }

  const cwd = typeof payload.arguments?.cwd === 'string' && payload.arguments.cwd.trim()
    ? payload.arguments.cwd.trim()
    : undefined;

  return {
    name: 'run_shell',
    arguments: {
      command,
      cwd
    }
  };
};

const parseAnthropicStepDone = (text: string): AnthropicStepDone | null => {
  const payload = parsePrefixedJson(text, ANTHROPIC_STEP_DONE_PREFIX) as { index?: unknown; note?: unknown } | null;
  if (!payload) {
    return null;
  }

  const index = typeof payload.index === 'number' ? Math.trunc(payload.index) : Number.NaN;
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }

  const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined;
  return { index, note };
};

const parseAnthropicFinal = (text: string): AnthropicFinal | null => {
  const payload = parsePrefixedJson(text, ANTHROPIC_FINAL_PREFIX) as { message?: unknown } | null;
  if (!payload) {
    return null;
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return null;
  }

  return { message };
};

const formatChecklist = (steps: string[], completed: boolean[]): string => {
  return steps.map((step, index) => `${completed[index] ? '[x]' : '[ ]'} ${index + 1}. ${step}`).join('\n');
};

const normalizeMacUsersPath = (value: string): string => {
  return process.platform === 'darwin' ? value.replace(/\/users\//gi, '/Users/') : value;
};

const resolveToolCwd = (workspacePath: string | undefined, requestedCwd?: string): string => {
  const base = workspacePath ?? process.cwd();
  if (!requestedCwd || !requestedCwd.trim()) {
    return base;
  }

  const candidate = normalizeMacUsersPath(requestedCwd.trim());
  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }

  return path.resolve(base, candidate);
};

const appendLimited = (current: string, chunk: string): string => {
  const next = current + chunk;
  if (next.length <= SHELL_OUTPUT_LIMIT) {
    return next;
  }
  return `${next.slice(0, SHELL_OUTPUT_LIMIT)}\n...[truncated]`;
};

const truncateForTrace = (value: string, max = 1200): string => {
  if (!value) {
    return '';
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated]`;
};

const runShellCommand = async (input: {
  command: string;
  cwd: string;
  signal: AbortSignal;
}): Promise<{
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> => {
  throwIfAborted(input.signal);
  const command = normalizeMacUsersPath(input.command);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd: input.cwd,
      env: process.env,
      shell: true
    });

    const finish = (payload: {
      ok: boolean;
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      resolve({
        command,
        cwd: input.cwd,
        ...payload
      });
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      reject(error);
    };

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      } catch {
        // ignore process kill errors
      }
      fail(new RequestCancelledError());
    };

    input.signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, SHELL_COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, String(chunk));
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, String(chunk));
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error && error.message ? error.message : 'Shell command failed.';
      fail(new Error(appendLimited(stderr, `\n${message}`).trim() || 'Shell command failed.'));
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      finish({
        ok: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        stdout,
        stderr
      });
    });
  });
};

const executeAnthropicToolCall = async (input: {
  toolCall: AnthropicToolCall;
  workspacePath?: string;
  accessMode: 'scoped' | 'root';
  workspace?: WorkspaceRow;
  signal: AbortSignal;
}): Promise<{
  ok: boolean;
  tool: 'run_shell';
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}> => {
  const cwd = resolveToolCwd(input.workspacePath, input.toolCall.arguments.cwd);
  const command = input.toolCall.arguments.command;

  try {
    enforceCommandPolicy({
      command,
      cwd,
      accessMode: input.accessMode,
      workspace: input.workspace
    });

    const result = await runShellCommand({
      command,
      cwd,
      signal: input.signal
    });

    return {
      ok: result.ok,
      tool: 'run_shell',
      command: result.command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    if (error instanceof RequestCancelledError) {
      throw error;
    }

    return {
      ok: false,
      tool: 'run_shell',
      command,
      cwd,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      error: asErrorMessage(error)
    };
  }
};

const stringifyToolResult = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const runAnthropicNativeTools = async (input: Parameters<ProviderRunner>[0]): Promise<{
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}> => {
  const model = resolveAnthropicModel(input.modelProfileId, input.requestedModelId);
  const workspacePath = input.workspace?.root_path;
  const systemPrompt = [
    'You are OpenVibez Anthropic coding assistant.',
    'Use run_shell whenever shell access is needed to inspect, verify, build, or modify a workspace task.',
    'Do not pretend commands ran if you did not actually call the tool.',
    'When the user asks to create or edit something, make the real changes and verify them.',
    `Access mode: ${input.accessMode}.`,
    `Workspace trust: ${input.workspace?.trust_level ?? 'none'}.`,
    workspacePath ? `Preferred working directory: ${workspacePath}` : 'No workspace directory is selected.'
  ].join('\n');

  const tools = [
    {
      name: 'run_shell',
      description: 'Execute a shell command and return stdout, stderr, exit code, and timeout information.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Optional working directory.' }
        },
        required: ['command']
      }
    }
  ];

  const nativeHistory: Array<{
    role: 'user' | 'assistant';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
        >;
  }> = [];

  for (const message of input.history) {
    if (message.role === 'system') {
      continue;
    }

    const content = message.content.trim();
    if (!content) {
      continue;
    }

    nativeHistory.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content
    });
  }

  if (nativeHistory.length === 0 || nativeHistory[0]?.role !== 'user') {
    nativeHistory.unshift({ role: 'user', content: 'Continue.' });
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sawToolCall = false;

  for (let step = 0; step < MAX_ANTHROPIC_TOOL_STEPS; step += 1) {
    throwIfAborted(input.signal);
    input.onEvent?.({
      type: 'status',
      text: step === 0 ? 'Planning...' : `Executing step ${step + 1}...`
    });

    const turn = await createAnthropicToolTurn({
      apiKey: input.secret!,
      model,
      system: systemPrompt,
      messages: nativeHistory,
      tools,
      signal: input.signal
    });

    totalInputTokens += turn.inputTokens ?? 0;
    totalOutputTokens += turn.outputTokens ?? 0;
    nativeHistory.push(turn.assistantMessage);

    if (turn.toolCalls.length === 0) {
      const text = turn.text.trim();
      if (!text && !sawToolCall) {
        throw new NativeToolFallbackError('Anthropic native tool mode produced no text and no tool calls.');
      }
      if (!text) {
        throw new Error('Anthropic returned an empty final response.');
      }

      input.onEvent?.({ type: 'assistant_delta', delta: text });
      return {
        text,
        inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
        outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined
      };
    }

    sawToolCall = true;

    const toolResultBlocks: Array<{ type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }> = [];

    for (const toolCall of turn.toolCalls) {
      if (toolCall.name !== 'run_shell') {
        throw new NativeToolFallbackError(`Unsupported Anthropic tool call: ${toolCall.name}`);
      }

      const command = typeof toolCall.input.command === 'string' ? toolCall.input.command.trim() : '';
      const cwd = typeof toolCall.input.cwd === 'string' ? toolCall.input.cwd.trim() : undefined;
      if (!command) {
        throw new NativeToolFallbackError('Anthropic run_shell tool call is missing a command.');
      }

      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'action',
          text: `Command:\n${command}\ncwd: ${cwd ?? workspacePath ?? process.cwd()}`,
          actionKind: 'command'
        }
      });
      input.onEvent?.({ type: 'status', text: 'Running command...' });

      const toolResult = await executeAnthropicToolCall({
        toolCall: {
          name: 'run_shell',
          arguments: { command, cwd }
        },
        workspacePath,
        accessMode: input.accessMode,
        workspace: input.workspace,
        signal: input.signal
      });

      const traceResultLines = [
        `exit: ${toolResult.exitCode ?? 'n/a'}${toolResult.timedOut ? ' (timeout)' : ''}`,
        toolResult.error ? `error:\n${truncateForTrace(toolResult.error)}` : '',
        toolResult.stdout ? `stdout:\n${truncateForTrace(toolResult.stdout)}` : '',
        toolResult.stderr ? `stderr:\n${truncateForTrace(toolResult.stderr)}` : ''
      ].filter((line) => line.length > 0);

      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'action',
          text: traceResultLines.join('\n\n'),
          actionKind: 'command-result'
        }
      });

      toolResultBlocks.push({
        type: 'tool_result',
        toolUseId: toolCall.id,
        content: stringifyToolResult({
          command: toolResult.command,
          cwd: toolResult.cwd,
          exitCode: toolResult.exitCode,
          timedOut: toolResult.timedOut,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
          ...(toolResult.error ? { error: toolResult.error } : {})
        }),
        ...(toolResult.ok ? {} : { isError: true })
      });
    }

    nativeHistory.push({
      role: 'user',
      content: toolResultBlocks
    });
  }

  throw new Error(`Anthropic native tool mode reached max steps (${MAX_ANTHROPIC_TOOL_STEPS}) without finishing.`);
};

const runAnthropicCompletion = async (input: {
  apiKey: string;
  model: string;
  history: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  signal: AbortSignal;
  onStatus?: (text: string) => void;
}): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> => {
  const completion = await createAnthropicCompletion({
    apiKey: input.apiKey,
    model: input.model,
    history: input.history,
    signal: input.signal,
    onEvent: (event) => {
      if (event.type === 'status' && event.text) {
        input.onStatus?.(event.text);
      }
    }
  });

  return {
    text: completion.text,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens
  };
};

const runAnthropicToolProtocol: ProviderRunner = async (input) => {
  const model = resolveAnthropicModel(input.modelProfileId, input.requestedModelId);
  const workspacePath = input.workspace?.root_path;
  const toolSystemMessage = buildAnthropicToolSystemPrompt({
    accessMode: input.accessMode,
    workspacePath,
    trustLevel: input.workspace?.trust_level
  });

  const agentHistory = [{ role: 'system' as const, content: toolSystemMessage }, ...input.history];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalResponse: string | null = null;
  let plan: AnthropicExecutionPlan | null = null;
  let completedSteps: boolean[] = [];

  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    throwIfAborted(input.signal);
    input.onEvent?.({ type: 'status', text: 'Planning checklist...' });

    const planningTurn = await runAnthropicCompletion({
      apiKey: input.secret!,
      model,
      history: agentHistory,
      signal: input.signal
    });

    totalInputTokens += planningTurn.inputTokens ?? 0;
    totalOutputTokens += planningTurn.outputTokens ?? 0;

    const parsedPlan = parseAnthropicPlan(planningTurn.text);
    if (parsedPlan) {
      plan = parsedPlan;
      completedSteps = Array(plan.steps.length).fill(false);
      agentHistory.push({ role: 'assistant', content: planningTurn.text });
      agentHistory.push({
        role: 'system',
        content: `CHECKLIST\n${formatChecklist(plan.steps, completedSteps)}`
      });
      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'plan',
          text: formatChecklist(plan.steps, completedSteps)
        }
      });
      continue;
    }

    agentHistory.push({ role: 'assistant', content: planningTurn.text });
    agentHistory.push({
      role: 'system',
      content: `Invalid protocol. Respond with ${ANTHROPIC_PLAN_PREFIX} {"steps":[...]}.`
    });
  }

  if (!plan) {
    throw new Error('Anthropic agent failed to produce a valid execution plan.');
  }

  for (let step = 0; step < MAX_ANTHROPIC_TOOL_STEPS; step += 1) {
    throwIfAborted(input.signal);
    const nextStepIndex = completedSteps.findIndex((done) => !done);
    const activeStep = nextStepIndex === -1 ? plan.steps.length : nextStepIndex + 1;

    input.onEvent?.({
      type: 'status',
      text: nextStepIndex === -1 ? 'Finalizing...' : `Executing step ${activeStep}/${plan.steps.length}...`
    });

    agentHistory.push({
      role: 'system',
      content: `CHECKLIST\n${formatChecklist(plan.steps, completedSteps)}\nCurrent step: ${activeStep}`
    });

    const modelTurn = await runAnthropicCompletion({
      apiKey: input.secret!,
      model,
      history: agentHistory,
      signal: input.signal
    });

    totalInputTokens += modelTurn.inputTokens ?? 0;
    totalOutputTokens += modelTurn.outputTokens ?? 0;

    const stepDone = parseAnthropicStepDone(modelTurn.text);
    if (stepDone) {
      if (stepDone.index > plan.steps.length) {
        agentHistory.push({ role: 'assistant', content: modelTurn.text });
        agentHistory.push({
          role: 'system',
          content: `Invalid ${ANTHROPIC_STEP_DONE_PREFIX} index ${stepDone.index}. Use 1..${plan.steps.length}.`
        });
        continue;
      }

      completedSteps[stepDone.index - 1] = true;
      const checklistText = formatChecklist(plan.steps, completedSteps);
      input.onEvent?.({
        type: 'status',
        text: `Step ${stepDone.index}/${plan.steps.length} complete`
      });
      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'plan',
          text: checklistText
        }
      });

      agentHistory.push({ role: 'assistant', content: modelTurn.text });
      agentHistory.push({
        role: 'system',
        content: `CHECKLIST_UPDATED\n${checklistText}`
      });
      continue;
    }

    const parsedFinal = parseAnthropicFinal(modelTurn.text);
    if (parsedFinal) {
      const allDone = completedSteps.every((done) => done);
      if (!allDone) {
        agentHistory.push({ role: 'assistant', content: modelTurn.text });
        agentHistory.push({
          role: 'system',
          content: `Cannot finalize yet. Remaining checklist:\n${formatChecklist(plan.steps, completedSteps)}`
        });
        continue;
      }

      finalResponse = parsedFinal.message;
      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'plan',
          text: `All ${plan.steps.length} steps complete.`
        }
      });
      input.onEvent?.({ type: 'status', text: 'Done' });
      break;
    }

    const toolCall = parseAnthropicToolCall(modelTurn.text);
    if (toolCall) {
      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'action',
          text: `Step ${activeStep} command:\n${toolCall.arguments.command}\ncwd: ${toolCall.arguments.cwd ?? workspacePath ?? process.cwd()}`,
          actionKind: 'command'
        }
      });
      input.onEvent?.({ type: 'status', text: 'Running command...' });

      const toolResult = await executeAnthropicToolCall({
        toolCall,
        workspacePath,
        accessMode: input.accessMode,
        workspace: input.workspace,
        signal: input.signal
      });

      const traceResultLines = [
        `exit: ${toolResult.exitCode ?? 'n/a'}${toolResult.timedOut ? ' (timeout)' : ''}`,
        toolResult.error ? `error:\n${truncateForTrace(toolResult.error)}` : '',
        toolResult.stdout ? `stdout:\n${truncateForTrace(toolResult.stdout)}` : '',
        toolResult.stderr ? `stderr:\n${truncateForTrace(toolResult.stderr)}` : ''
      ].filter((line) => line.length > 0);

      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'action',
          text: traceResultLines.join('\n\n'),
          actionKind: 'command-result'
        }
      });

      agentHistory.push({ role: 'assistant', content: modelTurn.text });
      agentHistory.push({
        role: 'system',
        content: `TOOL_RESULT ${JSON.stringify(toolResult)}`
      });
      continue;
    }

    agentHistory.push({ role: 'assistant', content: modelTurn.text });
    agentHistory.push({
      role: 'system',
      content: `Invalid protocol response. Use ${ANTHROPIC_TOOL_CALL_PREFIX}, ${ANTHROPIC_STEP_DONE_PREFIX}, or ${ANTHROPIC_FINAL_PREFIX}.`
    });
  }

  if (!finalResponse || !finalResponse.trim()) {
    throw new Error(`Anthropic agent reached max tool steps (${MAX_ANTHROPIC_TOOL_STEPS}) without finishing.`);
  }

  return {
    text: finalResponse,
    inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
    outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined
  };
};

export const runAnthropic: ProviderRunner = async (input) => {
  if (input.provider.type !== 'anthropic' || input.provider.auth_kind !== 'api_key') {
    throw new Error('Anthropic runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  try {
    return await runAnthropicNativeTools(input);
  } catch (error) {
    if (error instanceof RequestCancelledError) {
      throw error;
    }

    const message = asErrorMessage(error);
    const likelyNativeToolMiss =
      error instanceof NativeToolFallbackError ||
      /tool|schema|input_schema|tool_use|tool_result|unsupported|empty final response|no text and no tool calls/i.test(
        message
      );
    if (!likelyNativeToolMiss) {
      throw error;
    }

    input.onEvent?.({ type: 'status', text: 'Falling back to Anthropic compatibility tool mode...' });
  }

  try {
    return await runAnthropicToolProtocol(input);
  } catch (error) {
    if (error instanceof RequestCancelledError) {
      throw error;
    }

    const message = asErrorMessage(error);
    const likelyProtocolMiss =
      /protocol|tool|step_done|tool_call|final|max tool steps|failed to produce a valid execution plan/i.test(message);
    if (!likelyProtocolMiss) {
      throw error;
    }

    input.onEvent?.({ type: 'status', text: 'Falling back to direct Anthropic response...' });
    const completion = await createAnthropicCompletion({
      apiKey: input.secret,
      model: resolveAnthropicModel(input.modelProfileId, input.requestedModelId),
      history: input.history,
      signal: input.signal,
      onEvent: (event) => {
        if (event.type === 'status' && event.text) {
          input.onEvent?.({ type: 'status', text: event.text });
          return;
        }

        if (event.type === 'assistant_delta' && event.delta) {
          input.onEvent?.({ type: 'assistant_delta', delta: event.delta });
        }
      }
    });

    return {
      text: completion.text,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens
    };
  }
};
