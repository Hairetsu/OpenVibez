import { spawn } from 'node:child_process';
import path from 'node:path';
import { createOllamaCompletion } from '../providers/ollama';
import { enforceCommandPolicy } from './commandPolicy';
import { resolveOllamaModel } from './models';
import type { ProviderRunner } from './types';
import type { WorkspaceRow } from '../db';

const LOCAL_TOOL_CALL_PREFIX = 'TOOL_CALL';
const LOCAL_PLAN_PREFIX = 'PLAN';
const LOCAL_STEP_DONE_PREFIX = 'STEP_DONE';
const LOCAL_FINAL_PREFIX = 'FINAL';
const MAX_LOCAL_TOOL_STEPS = 24;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_LIMIT = 20_000;
const MAX_LOCAL_PLAN_STEPS = 12;

class RequestCancelledError extends Error {
  constructor(message = 'Request cancelled by user.') {
    super(message);
    this.name = 'AbortError';
  }
}

type LocalToolCall = {
  name: 'run_shell';
  arguments: {
    command: string;
    cwd?: string;
  };
};

type LocalExecutionPlan = {
  steps: string[];
};

type LocalStepDone = {
  index: number;
  note?: string;
};

type LocalFinal = {
  message: string;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new RequestCancelledError();
  }
};

const buildLocalToolSystemPrompt = (input: {
  accessMode: 'scoped' | 'root';
  workspacePath?: string;
  trustLevel?: 'trusted' | 'read_only' | 'untrusted';
}): string => {
  const context = input.workspacePath
    ? `Preferred working directory: ${input.workspacePath}`
    : 'No workspace directory is selected.';

  const trust = input.trustLevel ? `Workspace trust: ${input.trustLevel}.` : 'Workspace trust: none.';

  return [
    'You are OpenVibez local coding assistant with autonomous CLI tool access.',
    '',
    'You MUST follow this protocol:',
    `1) First response: ${LOCAL_PLAN_PREFIX} {"steps":["step 1","step 2",...]}`,
    `2) During execution: respond with either ${LOCAL_TOOL_CALL_PREFIX} {...} or ${LOCAL_STEP_DONE_PREFIX} {"index":<1-based>,"note":"optional"}`,
    `3) Only when every step is completed: ${LOCAL_FINAL_PREFIX} {"message":"final user response"}`,
    '',
    'Never claim a step is complete unless you verified the output using command results.',
    `When you need to execute a shell command, respond with exactly one line:`,
    `${LOCAL_TOOL_CALL_PREFIX} {"name":"run_shell","arguments":{"command":"<shell command>","cwd":"<optional cwd>"}}`,
    'No markdown, no extra text when calling a tool.',
    '',
    'Available tools:',
    '- run_shell(command: string, cwd?: string): run a shell command and return stdout/stderr/exit code.',
    '',
    'Use tools whenever they help fulfill the request. You may call tools repeatedly until done.',
    'Do not stop early. If the user asks to build/create/clone a project, produce actual project files, not only a directory or README.',
    'Before finalizing, verify key outputs exist by running shell checks (for example ls/find/test commands).',
    `Only return ${LOCAL_FINAL_PREFIX} after all planned steps are complete.`,
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

  return cleaned.slice(0, MAX_LOCAL_PLAN_STEPS);
};

const parseLocalPlan = (text: string): LocalExecutionPlan | null => {
  const payload = parsePrefixedJson(text, LOCAL_PLAN_PREFIX) as { steps?: unknown } | null;
  if (!payload) {
    return null;
  }

  if (!Array.isArray(payload.steps)) {
    return null;
  }

  const steps = sanitizePlanSteps(payload.steps.filter((entry): entry is string => typeof entry === 'string'));
  return { steps };
};

const parseLocalToolCall = (text: string): LocalToolCall | null => {
  const payload = parsePrefixedJson(text, LOCAL_TOOL_CALL_PREFIX) as {
    name?: unknown;
    arguments?: { command?: unknown; cwd?: unknown };
  } | null;
  if (!payload) {
    return null;
  }

  if (payload.name !== 'run_shell') {
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

const parseLocalStepDone = (text: string): LocalStepDone | null => {
  const payload = parsePrefixedJson(text, LOCAL_STEP_DONE_PREFIX) as { index?: unknown; note?: unknown } | null;
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

const parseLocalFinal = (text: string): LocalFinal | null => {
  const payload = parsePrefixedJson(text, LOCAL_FINAL_PREFIX) as { message?: unknown } | null;
  if (!payload) {
    return null;
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return null;
  }

  return { message };
};

const formatChecklist = (steps: string[], completed: boolean[]): string => (
  steps
    .map((step, index) => `${completed[index] ? '[x]' : '[ ]'} ${index + 1}. ${step}`)
    .join('\n')
);

const normalizeMacUsersPath = (value: string): string => (
  process.platform === 'darwin' ? value.replace(/\/users\//gi, '/Users/') : value
);

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

const executeLocalToolCall = async (input: {
  toolCall: LocalToolCall;
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
}> => {
  const cwd = resolveToolCwd(input.workspacePath, input.toolCall.arguments.cwd);

  enforceCommandPolicy({
    command: input.toolCall.arguments.command,
    cwd,
    accessMode: input.accessMode,
    workspace: input.workspace
  });

  const result = await runShellCommand({
    command: input.toolCall.arguments.command,
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
};

export const runLocalOllama: ProviderRunner = async (input) => {
  if (input.provider.type !== 'local' || input.provider.auth_kind !== 'api_key') {
    throw new Error('Local runner received incompatible provider configuration.');
  }

  const model = resolveOllamaModel(input.modelProfileId, input.requestedModelId);
  const workspacePath = input.workspace?.root_path;
  const toolSystemMessage = buildLocalToolSystemPrompt({
    accessMode: input.accessMode,
    workspacePath,
    trustLevel: input.workspace?.trust_level
  });

  const agentHistory = [{ role: 'system' as const, content: toolSystemMessage }, ...input.history];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalResponse: string | null = null;
  let plan: LocalExecutionPlan | null = null;
  let completedSteps: boolean[] = [];

  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    throwIfAborted(input.signal);
    input.onEvent?.({ type: 'status', text: 'Planning checklist...' });
    input.onEvent?.({
      type: 'assistant_delta',
      delta: attempt === 0 ? 'Creating execution plan...\n' : 'Retrying plan format...\n'
    });

    const planningTurn = await createOllamaCompletion({
      baseUrl: input.secret ?? undefined,
      model,
      history: agentHistory,
      stream: false,
      signal: input.signal
    });

    totalInputTokens += planningTurn.inputTokens ?? 0;
    totalOutputTokens += planningTurn.outputTokens ?? 0;

    const parsedPlan = parseLocalPlan(planningTurn.text);
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
      input.onEvent?.({
        type: 'assistant_delta',
        delta: `Plan (${plan.steps.length} steps):\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n`
      });
    } else {
      agentHistory.push({ role: 'assistant', content: planningTurn.text });
      agentHistory.push({
        role: 'system',
        content: `Invalid protocol. Respond with ${LOCAL_PLAN_PREFIX} {"steps":[...]}.`
      });
    }
  }

  if (!plan) {
    throw new Error('Local agent failed to produce a valid execution plan.');
  }

  for (let step = 0; step < MAX_LOCAL_TOOL_STEPS; step += 1) {
    throwIfAborted(input.signal);
    const nextStepIndex = completedSteps.findIndex((done) => !done);
    const activeStep = nextStepIndex === -1 ? plan.steps.length : nextStepIndex + 1;

    input.onEvent?.({
      type: 'status',
      text: nextStepIndex === -1 ? 'Finalizing...' : `Executing step ${activeStep}/${plan.steps.length}...`
    });

    input.onEvent?.({
      type: 'assistant_delta',
      delta: `\nIteration ${step + 1}: ${nextStepIndex === -1 ? 'finalization' : `step ${activeStep}`}\n`
    });

    agentHistory.push({
      role: 'system',
      content: `CHECKLIST\n${formatChecklist(plan.steps, completedSteps)}\nCurrent step: ${activeStep}`
    });

    const modelTurn = await createOllamaCompletion({
      baseUrl: input.secret ?? undefined,
      model,
      history: agentHistory,
      stream: false,
      signal: input.signal
    });

    totalInputTokens += modelTurn.inputTokens ?? 0;
    totalOutputTokens += modelTurn.outputTokens ?? 0;

    input.onEvent?.({
      type: 'trace',
      trace: {
        traceKind: 'action',
        text: `Model turn ${step + 1}: ${truncateForTrace(modelTurn.text, 400)}`,
        actionKind: 'generic'
      }
    });

    const stepDone = parseLocalStepDone(modelTurn.text);
    if (stepDone) {
      if (stepDone.index > plan.steps.length) {
        agentHistory.push({ role: 'assistant', content: modelTurn.text });
        agentHistory.push({
          role: 'system',
          content: `Invalid ${LOCAL_STEP_DONE_PREFIX} index ${stepDone.index}. Use 1..${plan.steps.length}.`
        });
        continue;
      }

      completedSteps[stepDone.index - 1] = true;
      const checklistText = formatChecklist(plan.steps, completedSteps);
      input.onEvent?.({
        type: 'trace',
        trace: {
          traceKind: 'plan',
          text: checklistText
        }
      });
      input.onEvent?.({
        type: 'assistant_delta',
        delta: `Checked off step ${stepDone.index}: ${plan.steps[stepDone.index - 1]}\n`
      });

      agentHistory.push({ role: 'assistant', content: modelTurn.text });
      agentHistory.push({
        role: 'system',
        content: `CHECKLIST_UPDATED\n${checklistText}`
      });
      continue;
    }

    const parsedFinal = parseLocalFinal(modelTurn.text);
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
      input.onEvent?.({
        type: 'assistant_delta',
        delta: `${finalResponse}\n`
      });
      break;
    }

    const toolCall = parseLocalToolCall(modelTurn.text);
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
      input.onEvent?.({ type: 'assistant_delta', delta: `$ ${toolCall.arguments.command}\n` });

      const toolResult = await executeLocalToolCall({
        toolCall,
        workspacePath,
        accessMode: input.accessMode,
        workspace: input.workspace,
        signal: input.signal
      });

      const traceResultLines = [
        `exit: ${toolResult.exitCode ?? 'n/a'}${toolResult.timedOut ? ' (timeout)' : ''}`,
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
      input.onEvent?.({
        type: 'assistant_delta',
        delta: `exit ${toolResult.exitCode ?? 'n/a'}${toolResult.timedOut ? ' (timeout)' : ''}\n`
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
      content:
        `Invalid protocol response. Use ${LOCAL_TOOL_CALL_PREFIX}, ${LOCAL_STEP_DONE_PREFIX}, or ${LOCAL_FINAL_PREFIX}.`
    });
  }

  if (!finalResponse || !finalResponse.trim()) {
    throw new Error(`Local agent reached max tool steps (${MAX_LOCAL_TOOL_STEPS}) without finishing.`);
  }

  return {
    text: finalResponse,
    inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
    outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined
  };
};
