import { spawn } from 'node:child_process';
import path from 'node:path';
import type { WorkspaceRow } from '../db';
import { createOpenAICompletion } from '../providers/openai';
import { enforceCommandPolicy } from './commandPolicy';
import { resolveGrokModel } from './models';
import type { ProviderRunner } from './types';

const GROK_API_BASE_URL = 'https://api.x.ai/v1';
const GROK_TOOL_CALL_PREFIX = 'TOOL_CALL';
const GROK_PLAN_PREFIX = 'PLAN';
const GROK_STEP_DONE_PREFIX = 'STEP_DONE';
const GROK_FINAL_PREFIX = 'FINAL';
const MAX_GROK_TOOL_STEPS = 24;
const MAX_GROK_PLAN_STEPS = 12;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_LIMIT = 20_000;

class RequestCancelledError extends Error {
  constructor(message = 'Request cancelled by user.') {
    super(message);
    this.name = 'AbortError';
  }
}

type GrokToolCall = {
  name: 'run_shell';
  arguments: {
    command: string;
    cwd?: string;
  };
};

type GrokExecutionPlan = {
  steps: string[];
};

type GrokStepDone = {
  index: number;
  note?: string;
};

type GrokFinal = { message: string };

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

const buildGrokToolSystemPrompt = (input: {
  accessMode: 'scoped' | 'root';
  workspacePath?: string;
  trustLevel?: 'trusted' | 'read_only' | 'untrusted';
}): string => {
  const context = input.workspacePath
    ? `Preferred working directory: ${input.workspacePath}`
    : 'No workspace directory is selected.';

  const trust = input.trustLevel ? `Workspace trust: ${input.trustLevel}.` : 'Workspace trust: none.';

  return [
    'You are OpenVibez Grok coding assistant with autonomous CLI tool access.',
    '',
    'You MUST follow this protocol:',
    `1) First response: ${GROK_PLAN_PREFIX} {"steps":["step 1","step 2",...]}`,
    `2) During execution: respond with either ${GROK_TOOL_CALL_PREFIX} {...} or ${GROK_STEP_DONE_PREFIX} {"index":<1-based>,"note":"optional"}`,
    `3) Only when every step is completed: ${GROK_FINAL_PREFIX} {"message":"final user response"}`,
    '',
    'Never claim a step is complete unless command output verified it.',
    `When you need to execute a shell command, respond with exactly one line:`,
    `${GROK_TOOL_CALL_PREFIX} {"name":"run_shell","arguments":{"command":"<shell command>","cwd":"<optional cwd>"}}`,
    'No markdown and no extra text when calling a tool.',
    '',
    'Available tools:',
    '- run_shell(command: string, cwd?: string): run a shell command and return stdout, stderr, exit code, and timeout info.',
    '',
    'Use tools whenever they help fulfill the request. You may call tools repeatedly until done.',
    'Do not stop early. Before finalizing, verify key outputs exist by running shell checks.',
    `Only return ${GROK_FINAL_PREFIX} after all planned steps are complete.`,
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

  return cleaned.slice(0, MAX_GROK_PLAN_STEPS);
};

const parseGrokPlan = (text: string): GrokExecutionPlan | null => {
  const payload = parsePrefixedJson(text, GROK_PLAN_PREFIX) as { steps?: unknown } | null;
  if (!payload || !Array.isArray(payload.steps)) {
    return null;
  }

  const steps = sanitizePlanSteps(payload.steps.filter((entry): entry is string => typeof entry === 'string'));
  return { steps };
};

const parseGrokToolCall = (text: string): GrokToolCall | null => {
  const payload = parsePrefixedJson(text, GROK_TOOL_CALL_PREFIX) as {
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

const parseGrokStepDone = (text: string): GrokStepDone | null => {
  const payload = parsePrefixedJson(text, GROK_STEP_DONE_PREFIX) as { index?: unknown; note?: unknown } | null;
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

const parseGrokFinal = (text: string): GrokFinal | null => {
  const payload = parsePrefixedJson(text, GROK_FINAL_PREFIX) as { message?: unknown } | null;
  if (!payload) {
    return null;
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return null;
  }

  return { message };
};

const createFinalMessageDeltaParser = (): {
  push: (chunk: string) => string;
} => {
  let buffer = '';
  let scanIndex = 0;
  let finalSeen = false;
  let messageStarted = false;
  let messageEnded = false;
  let escaped = false;
  let unicodeDigitsRemaining = 0;
  const MAX_BUFFER = 4096;

  const trimBuffer = () => {
    if (buffer.length <= MAX_BUFFER) {
      return;
    }
    const drop = buffer.length - MAX_BUFFER;
    buffer = buffer.slice(drop);
    scanIndex = Math.max(0, scanIndex - drop);
  };

  return {
    push: (chunk: string): string => {
      if (!chunk || messageEnded) {
        return '';
      }

      buffer += chunk;
      let streamed = '';

      while (true) {
        if (!finalSeen) {
          const finalIndex = buffer.indexOf(GROK_FINAL_PREFIX, scanIndex);
          if (finalIndex === -1) {
            scanIndex = Math.max(0, buffer.length - 16);
            trimBuffer();
            return streamed;
          }

          finalSeen = true;
          scanIndex = finalIndex + GROK_FINAL_PREFIX.length;
        }

        if (!messageStarted) {
          const messageMatch = /"message"\s*:\s*"/g;
          messageMatch.lastIndex = scanIndex;
          const match = messageMatch.exec(buffer);
          if (!match) {
            scanIndex = Math.max(0, buffer.length - 32);
            trimBuffer();
            return streamed;
          }

          messageStarted = true;
          scanIndex = messageMatch.lastIndex;
        }

        while (scanIndex < buffer.length) {
          const ch = buffer[scanIndex];
          scanIndex += 1;

          if (unicodeDigitsRemaining > 0) {
            unicodeDigitsRemaining -= 1;
            if (unicodeDigitsRemaining === 0) {
              streamed += '?';
            }
            continue;
          }

          if (escaped) {
            escaped = false;
            if (ch === 'n') {
              streamed += '\n';
            } else if (ch === 't') {
              streamed += '\t';
            } else if (ch === 'r') {
              streamed += '\r';
            } else if (ch === 'b') {
              streamed += '\b';
            } else if (ch === 'f') {
              streamed += '\f';
            } else if (ch === 'u') {
              unicodeDigitsRemaining = 4;
            } else {
              streamed += ch;
            }
            continue;
          }

          if (ch === '\\') {
            escaped = true;
            continue;
          }

          if (ch === '"') {
            messageEnded = true;
            trimBuffer();
            return streamed;
          }

          streamed += ch;
        }

        trimBuffer();
        return streamed;
      }
    }
  };
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

const executeGrokToolCall = async (input: {
  toolCall: GrokToolCall;
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

const runGrokCompletion = async (input: {
  apiKey: string;
  providerId: string;
  model: string;
  history: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  signal: AbortSignal;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
}): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> => {
  const completion = await createOpenAICompletion({
    apiKey: input.apiKey,
    baseUrl: GROK_API_BASE_URL,
    providerId: input.providerId,
    model: input.model,
    history: input.history,
    backgroundModeEnabled: false,
    signal: input.signal,
    onEvent: input.onEvent
  });

  return {
    text: completion.text,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens
  };
};

export const runGrok: ProviderRunner = async (input) => {
  if (input.provider.type !== 'grok' || input.provider.auth_kind !== 'api_key') {
    throw new Error('Grok runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  const model = resolveGrokModel(input.modelProfileId, input.requestedModelId);
  const workspacePath = input.workspace?.root_path;
  const toolSystemMessage = buildGrokToolSystemPrompt({
    accessMode: input.accessMode,
    workspacePath,
    trustLevel: input.workspace?.trust_level
  });

  const agentHistory = [{ role: 'system' as const, content: toolSystemMessage }, ...input.history];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalResponse: string | null = null;
  let plan: GrokExecutionPlan | null = null;
  let completedSteps: boolean[] = [];

  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    throwIfAborted(input.signal);
    input.onEvent?.({ type: 'status', text: 'Planning checklist...' });

    const planningTurn = await runGrokCompletion({
      apiKey: input.secret,
      providerId: input.provider.id,
      model,
      history: agentHistory,
      signal: input.signal
    });

    totalInputTokens += planningTurn.inputTokens ?? 0;
    totalOutputTokens += planningTurn.outputTokens ?? 0;

    const parsedPlan = parseGrokPlan(planningTurn.text);
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
      content: `Invalid protocol. Respond with ${GROK_PLAN_PREFIX} {"steps":[...]}.`
    });
  }

  if (!plan) {
    throw new Error('Grok agent failed to produce a valid execution plan.');
  }

  for (let step = 0; step < MAX_GROK_TOOL_STEPS; step += 1) {
    throwIfAborted(input.signal);
    const nextStepIndex = completedSteps.findIndex((done) => !done);
    const activeStep = nextStepIndex === -1 ? plan.steps.length : nextStepIndex + 1;
    const canStreamFinalSummary = nextStepIndex === -1;

    input.onEvent?.({
      type: 'status',
      text: nextStepIndex === -1 ? 'Finalizing...' : `Executing step ${activeStep}/${plan.steps.length}...`
    });

    agentHistory.push({
      role: 'system',
      content: `CHECKLIST\n${formatChecklist(plan.steps, completedSteps)}\nCurrent step: ${activeStep}`
    });

    const finalDeltaParser = createFinalMessageDeltaParser();
    let streamedFinalSummary = '';
    let finalSummaryStreamingStarted = false;

    const modelTurn = await runGrokCompletion({
      apiKey: input.secret,
      providerId: input.provider.id,
      model,
      history: agentHistory,
      signal: input.signal,
      onEvent: (event) => {
        if (event.type !== 'assistant_delta' || !event.delta) {
          return;
        }

        if (!canStreamFinalSummary) {
          return;
        }

        const delta = finalDeltaParser.push(event.delta);
        if (!delta) {
          return;
        }

        if (!finalSummaryStreamingStarted) {
          finalSummaryStreamingStarted = true;
          input.onEvent?.({ type: 'status', text: 'Streaming final summary...' });
        }

        streamedFinalSummary += delta;
        input.onEvent?.({ type: 'assistant_delta', delta });
      }
    });

    totalInputTokens += modelTurn.inputTokens ?? 0;
    totalOutputTokens += modelTurn.outputTokens ?? 0;

    const stepDone = parseGrokStepDone(modelTurn.text);
    if (stepDone) {
      if (stepDone.index > plan.steps.length) {
        agentHistory.push({ role: 'assistant', content: modelTurn.text });
        agentHistory.push({
          role: 'system',
          content: `Invalid ${GROK_STEP_DONE_PREFIX} index ${stepDone.index}. Use 1..${plan.steps.length}.`
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

    const parsedFinal = parseGrokFinal(modelTurn.text);
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

      finalResponse = streamedFinalSummary.trim() || parsedFinal.message;
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

    const toolCall = parseGrokToolCall(modelTurn.text);
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

      const toolResult = await executeGrokToolCall({
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
      content: `Invalid protocol response. Use ${GROK_TOOL_CALL_PREFIX}, ${GROK_STEP_DONE_PREFIX}, or ${GROK_FINAL_PREFIX}.`
    });
  }

  if (!finalResponse || !finalResponse.trim()) {
    throw new Error(`Grok agent reached max tool steps (${MAX_GROK_TOOL_STEPS}) without finishing.`);
  }

  return {
    text: finalResponse,
    inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
    outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined
  };
};
