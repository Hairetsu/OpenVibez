import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  addMessage,
  archiveSession,
  createSession,
  getModelProfileById,
  getProviderById,
  getSetting,
  getSessionById,
  getWorkspaceById,
  listMessages,
  listSessions,
  markProviderUsed,
  recordUsageEvent,
  setSessionTitle,
  setSessionProvider
} from '../services/db';
import { getSecret } from '../services/keychain';
import { createCodexCompletion, getCodexLoginStatus } from '../services/providers/codex';
import { createOllamaCompletion } from '../services/providers/ollama';
import { createOpenAICompletion } from '../services/providers/openai';
import { logger } from '../util/logger';
import {
  messageCancelSchema,
  messageListSchema,
  messageSendSchema,
  sessionArchiveSchema,
  sessionCreateSchema,
  sessionSetProviderSchema
} from './contracts';

const mapSession = (row: {
  id: string;
  workspace_id: string | null;
  title: string;
  provider_id: string;
  model_profile_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
}) => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  providerId: row.provider_id,
  modelProfileId: row.model_profile_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastMessageAt: row.last_message_at
});

const mapMessage = (row: {
  id: string;
  session_id: string;
  role: string;
  content: string;
  content_format: string;
  tool_name: string | null;
  tool_call_id: string | null;
  seq: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microunits: number | null;
  created_at: number;
}) => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role,
  content: row.content,
  contentFormat: row.content_format,
  toolName: row.tool_name,
  toolCallId: row.tool_call_id,
  seq: row.seq,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  costMicrounits: row.cost_microunits,
  createdAt: row.created_at
});

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:latest';
const HISTORY_WINDOW = 30;
const LOCAL_TOOL_CALL_PREFIX = 'TOOL_CALL';
const LOCAL_PLAN_PREFIX = 'PLAN';
const LOCAL_STEP_DONE_PREFIX = 'STEP_DONE';
const LOCAL_FINAL_PREFIX = 'FINAL';
const MAX_LOCAL_TOOL_STEPS = 24;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_LIMIT = 20_000;
const MAX_LOCAL_PLAN_STEPS = 12;
const SESSION_TITLE_MAX_LENGTH = 80;
const SESSION_TITLE_TEXT_WINDOW = 1000;
const SESSION_TITLE_PLACEHOLDER = /^(new vibe session|new session|session\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?)$/i;

class RequestCancelledError extends Error {
  constructor(message = 'Request cancelled by user.') {
    super(message);
    this.name = 'AbortError';
  }
}

type InflightRequest = {
  streamId: string;
  controller: AbortController;
  cancel: () => void;
};

const inflightRequests = new Map<string, InflightRequest>();

const isCancellationError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as { name?: unknown; message?: unknown };
  const message = typeof err.message === 'string' ? err.message : '';
  return err.name === 'AbortError' || /cancelled|canceled|aborted/i.test(message);
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new RequestCancelledError();
  }
};

const asMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Unknown provider error';
};

const makeStreamId = (): string => `stream_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

const isSessionTitlePlaceholder = (title: string): boolean => {
  const trimmed = title.trim();
  if (!trimmed) {
    return true;
  }

  return SESSION_TITLE_PLACEHOLDER.test(trimmed);
};

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeSessionTitle = (value: string): string => {
  const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? '';
  const withoutPrefix = firstLine.replace(/^title\s*:\s*/i, '');
  const stripped = withoutPrefix.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
  const compact = compactWhitespace(stripped);

  if (!compact) {
    return '';
  }

  if (compact.length <= SESSION_TITLE_MAX_LENGTH) {
    return compact;
  }

  return compact.slice(0, SESSION_TITLE_MAX_LENGTH).trim();
};

const clipForTitle = (value: string): string => {
  const compact = compactWhitespace(value);
  if (compact.length <= SESSION_TITLE_TEXT_WINDOW) {
    return compact;
  }
  return `${compact.slice(0, SESSION_TITLE_TEXT_WINDOW).trim()}...`;
};

const emitStream = (
  event: IpcMainInvokeEvent,
  payload: {
    streamId: string;
    sessionId: string;
    type: 'status' | 'trace' | 'text_delta' | 'error' | 'done';
    text?: string;
    trace?: { traceKind: 'thought' | 'plan' | 'action'; text: string };
  }
): void => {
  try {
    if (!event.sender.isDestroyed()) {
      event.sender.send('message:stream-event', payload);
    }
  } catch {
    // Renderer might be navigating or closed.
  }
};

const resolveOpenAIModel = (modelProfileId: string | null, requestedModelId?: string): string => {
  if (requestedModelId && requestedModelId.trim()) {
    return requestedModelId;
  }

  if (modelProfileId) {
    const profile = getModelProfileById(modelProfileId);
    if (profile?.model_id) {
      return profile.model_id;
    }
  }

  const fromSettings = getSetting('default_model_id');
  if (typeof fromSettings === 'string' && fromSettings.trim()) {
    return fromSettings;
  }

  return DEFAULT_OPENAI_MODEL;
};

const resolveOllamaModel = (modelProfileId: string | null, requestedModelId?: string): string => {
  if (requestedModelId && requestedModelId.trim()) {
    return requestedModelId;
  }

  if (modelProfileId) {
    const profile = getModelProfileById(modelProfileId);
    if (profile?.model_id) {
      return profile.model_id;
    }
  }

  return DEFAULT_OLLAMA_MODEL;
};

const generateSessionTitle = async (input: {
  providerId: string;
  modelProfileId: string | null;
  requestedModelId?: string;
  userMessage: string;
  assistantMessage: string;
  signal: AbortSignal;
}): Promise<string | null> => {
  const provider = getProviderById(input.providerId);
  if (!provider) {
    return null;
  }

  const userText = clipForTitle(input.userMessage);
  const assistantText = clipForTitle(input.assistantMessage);
  if (!userText || !assistantText) {
    return null;
  }

  const history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    {
      role: 'system',
      content:
        'You generate short conversation titles. Return only a concise title (2-6 words), no quotes, no punctuation at the end.'
    },
    {
      role: 'user',
      content: [
        'Create a title for this conversation:',
        `User: ${userText}`,
        `Assistant: ${assistantText}`,
        'Return title only.'
      ].join('\n')
    }
  ];

  if (provider.auth_kind === 'oauth_subscription') {
    if (provider.type !== 'openai') {
      return null;
    }

    const completion = await createCodexCompletion({
      history,
      model: input.requestedModelId,
      signal: input.signal
    });

    const title = sanitizeSessionTitle(completion.text);
    return title || null;
  }

  if (!provider.keychain_ref) {
    return null;
  }

  const secret = await getSecret(provider.keychain_ref);

  if (provider.type === 'openai') {
    if (!secret) {
      return null;
    }

    const completion = await createOpenAICompletion({
      apiKey: secret,
      model: resolveOpenAIModel(input.modelProfileId, input.requestedModelId),
      history,
      temperature: 0.2,
      maxOutputTokens: 24,
      signal: input.signal
    });

    const title = sanitizeSessionTitle(completion.text);
    return title || null;
  }

  if (provider.type === 'local') {
    const completion = await createOllamaCompletion({
      baseUrl: secret ?? undefined,
      model: resolveOllamaModel(input.modelProfileId, input.requestedModelId),
      history,
      temperature: 0.2,
      maxOutputTokens: 24,
      stream: false,
      signal: input.signal
    });

    const title = sanitizeSessionTitle(completion.text);
    return title || null;
  }

  return null;
};

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

const buildLocalToolSystemPrompt = (input: {
  accessMode: 'scoped' | 'root';
  workspacePath?: string;
}): string => {
  const context = input.workspacePath
    ? `Preferred working directory: ${input.workspacePath}`
    : 'No workspace directory is selected.';

  return [
    'You are OpenVibez local coding assistant with autonomous CLI tool access.',
    '',
    'You MUST follow this protocol:',
    `1) First response: ${LOCAL_PLAN_PREFIX} {"steps":["step 1","step 2",...]}`,
    `2) During execution: respond with either ${LOCAL_TOOL_CALL_PREFIX} {...} or ${LOCAL_STEP_DONE_PREFIX} {"index":<1-based>,"note":"optional"}`,
    `3) Only when every step is completed: ${LOCAL_FINAL_PREFIX} {"message":"final user response"}`,
    '',
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
      fail(new Error(appendLimited(stderr, `\n${asMessage(error)}`).trim() || 'Shell command failed.'));
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

export const registerChatHandlers = (): void => {
  ipcMain.handle('session:create', (_event, input) => {
    const parsed = sessionCreateSchema.parse(input);
    const session = createSession(parsed);
    return mapSession(session);
  });

  ipcMain.handle('session:setProvider', (_event, input) => {
    const parsed = sessionSetProviderSchema.parse(input);
    const provider = getProviderById(parsed.providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    const session = setSessionProvider(parsed);
    return mapSession(session);
  });

  ipcMain.handle('session:list', () => {
    return listSessions().map(mapSession);
  });

  ipcMain.handle('session:archive', (_event, input) => {
    const parsed = sessionArchiveSchema.parse(input);
    archiveSession(parsed.sessionId);
    return { ok: true };
  });

  ipcMain.handle('message:list', (_event, input) => {
    const parsed = messageListSchema.parse(input);
    return listMessages(parsed.sessionId).map(mapMessage);
  });

  ipcMain.handle('message:cancel', (_event, input) => {
    const parsed = messageCancelSchema.parse(input);
    const inflight = inflightRequests.get(parsed.streamId);
    if (!inflight) {
      return { ok: false };
    }

    inflight.cancel();
    return { ok: true };
  });

  ipcMain.handle('message:send', async (event, input) => {
    const parsed = messageSendSchema.parse(input);
    const session = getSessionById(parsed.sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    const streamId = parsed.streamId ?? makeStreamId();
    const controller = new AbortController();

    const inflight: InflightRequest = {
      streamId,
      controller,
      cancel: () => {
        if (!controller.signal.aborted) {
          controller.abort(new RequestCancelledError());
        }
      }
    };
    inflightRequests.set(streamId, inflight);

    emitStream(event, {
      streamId,
      sessionId: parsed.sessionId,
      type: 'status',
      text: 'Queued'
    });

    const existingMessages = listMessages(parsed.sessionId);
    const shouldGenerateSessionTitle = existingMessages.length === 0 || isSessionTitlePlaceholder(session.title);

    const userMessage = addMessage({
      sessionId: parsed.sessionId,
      role: 'user',
      content: parsed.content
    });

    let assistantContent = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      throwIfAborted(controller.signal);
      const provider = getProviderById(session.provider_id);
      if (!provider) {
        throw new Error('Provider for this session could not be found.');
      }
      if (!provider.keychain_ref) {
        throw new Error('Provider has no keychain reference. Save your API key first.');
      }

      const secret = await getSecret(provider.keychain_ref);
      throwIfAborted(controller.signal);
      const workspaceId = parsed.workspaceId ?? session.workspace_id ?? null;
      const workspacePath = workspaceId ? getWorkspaceById(workspaceId)?.root_path : undefined;
      const effectiveAccessMode = parsed.accessMode ?? 'scoped';
      const history = [...existingMessages, userMessage]
        .slice(-HISTORY_WINDOW)
        .map((message) => ({ role: message.role, content: message.content }));

      if (provider.auth_kind === 'oauth_subscription') {
        if (provider.type !== 'openai') {
          throw new Error('Subscription auth is currently supported only for OpenAI providers.');
        }

        const login = await getCodexLoginStatus();
        if (!login.loggedIn) {
          throw new Error(
            'ChatGPT subscription is not connected yet. Use Connect ChatGPT in Settings, then run Check Support.'
          );
        }

        const completion = await createCodexCompletion({
          history,
          cwd: workspacePath,
          model: parsed.modelId,
          fullAccess: parsed.accessMode === 'root',
          signal: controller.signal,
          onEvent: (streamEvent) => {
            if (streamEvent.type === 'status' && streamEvent.text) {
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'status',
                text: streamEvent.text
              });
              return;
            }

            if (streamEvent.type === 'trace') {
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'trace',
                trace: {
                  traceKind: streamEvent.traceKind,
                  text: streamEvent.text
                }
              });
              return;
            }

            if (streamEvent.type === 'assistant_delta' && streamEvent.delta) {
              assistantContent += streamEvent.delta;
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'text_delta',
                text: streamEvent.delta
              });
            }
          }
        });

        assistantContent = completion.text;
        inputTokens = completion.inputTokens;
        outputTokens = completion.outputTokens;
      } else {
        if (provider.type === 'openai') {
          if (!secret) {
            throw new Error('No API key stored for this provider yet.');
          }

          const completion = await createOpenAICompletion({
            apiKey: secret,
            model: resolveOpenAIModel(session.model_profile_id, parsed.modelId),
            history,
            signal: controller.signal,
            onEvent: (streamEvent) => {
              if (streamEvent.type === 'status' && streamEvent.text) {
                emitStream(event, {
                  streamId,
                  sessionId: parsed.sessionId,
                  type: 'status',
                  text: streamEvent.text
                });
                return;
              }

              if (streamEvent.type === 'assistant_delta' && streamEvent.delta) {
                assistantContent += streamEvent.delta;
                emitStream(event, {
                  streamId,
                  sessionId: parsed.sessionId,
                  type: 'text_delta',
                  text: streamEvent.delta
                });
              }
            }
          });

          assistantContent = completion.text;
          inputTokens = completion.inputTokens;
          outputTokens = completion.outputTokens;
        } else if (provider.type === 'local') {
          const model = resolveOllamaModel(session.model_profile_id, parsed.modelId);
          const toolSystemMessage = buildLocalToolSystemPrompt({
            accessMode: effectiveAccessMode,
            workspacePath
          });
          const agentHistory = [{ role: 'system' as const, content: toolSystemMessage }, ...history];
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          let finalResponse: string | null = null;
          let plan: LocalExecutionPlan | null = null;
          let completedSteps: boolean[] = [];

          for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
            throwIfAborted(controller.signal);
            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'status',
              text: 'Planning checklist...'
            });
            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'text_delta',
              text: attempt === 0 ? 'Creating execution plan...\n' : 'Retrying plan format...\n'
            });

            const planningTurn = await createOllamaCompletion({
              baseUrl: secret ?? undefined,
              model,
              history: agentHistory,
              stream: false,
              signal: controller.signal
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
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'trace',
                trace: {
                  traceKind: 'plan',
                  text: formatChecklist(plan.steps, completedSteps)
                }
              });
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'text_delta',
                text: `Plan (${plan.steps.length} steps):\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n`
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
            throwIfAborted(controller.signal);
            const nextStepIndex = completedSteps.findIndex((done) => !done);
            const activeStep = nextStepIndex === -1 ? plan.steps.length : nextStepIndex + 1;

            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'status',
              text: nextStepIndex === -1 ? 'Finalizing...' : `Executing step ${activeStep}/${plan.steps.length}...`
            });
            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'text_delta',
              text: `\nIteration ${step + 1}: ${nextStepIndex === -1 ? 'finalization' : `step ${activeStep}`}\n`
            });

            agentHistory.push({
              role: 'system',
              content: `CHECKLIST\n${formatChecklist(plan.steps, completedSteps)}\nCurrent step: ${activeStep}`
            });

            const modelTurn = await createOllamaCompletion({
              baseUrl: secret ?? undefined,
              model,
              history: agentHistory,
              stream: false,
              signal: controller.signal
            });

            totalInputTokens += modelTurn.inputTokens ?? 0;
            totalOutputTokens += modelTurn.outputTokens ?? 0;

            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'trace',
              trace: {
                traceKind: 'action',
                text: `Model turn ${step + 1}: ${truncateForTrace(modelTurn.text, 400)}`
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
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'trace',
                trace: {
                  traceKind: 'plan',
                  text: checklistText
                }
              });
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'text_delta',
                text: `Checked off step ${stepDone.index}: ${plan.steps[stepDone.index - 1]}\n`
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
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'trace',
                trace: {
                  traceKind: 'plan',
                  text: `All ${plan.steps.length} steps complete.`
                }
              });
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'text_delta',
                text: `${finalResponse}\n`
              });
              break;
            }

            const toolCall = parseLocalToolCall(modelTurn.text);
            if (toolCall) {
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'trace',
                trace: {
                  traceKind: 'action',
                  text: `Step ${activeStep} command:\n${toolCall.arguments.command}\ncwd: ${toolCall.arguments.cwd ?? workspacePath ?? process.cwd()}`
                }
              });
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'status',
                text: 'Running command...'
              });
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'text_delta',
                text: `$ ${toolCall.arguments.command}\n`
              });

              const toolResult = await executeLocalToolCall({
                toolCall,
                workspacePath,
                signal: controller.signal
              });

              const traceResultLines = [
                `exit: ${toolResult.exitCode ?? 'n/a'}${toolResult.timedOut ? ' (timeout)' : ''}`,
                toolResult.stdout ? `stdout:\n${truncateForTrace(toolResult.stdout)}` : '',
                toolResult.stderr ? `stderr:\n${truncateForTrace(toolResult.stderr)}` : ''
              ].filter((line) => line.length > 0);

              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'trace',
                trace: {
                  traceKind: 'action',
                  text: traceResultLines.join('\n\n')
                }
              });
              emitStream(event, {
                streamId,
                sessionId: parsed.sessionId,
                type: 'text_delta',
                text: `exit ${toolResult.exitCode ?? 'n/a'}${toolResult.timedOut ? ' (timeout)' : ''}\n`
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

          assistantContent = finalResponse;
          inputTokens = totalInputTokens > 0 ? totalInputTokens : undefined;
          outputTokens = totalOutputTokens > 0 ? totalOutputTokens : undefined;
        } else {
          throw new Error(`Provider "${provider.type}" is not wired yet in v1.`);
        }
      }
    } catch (error) {
      if (isCancellationError(error)) {
        const partial = assistantContent.trim();
        assistantContent = partial || 'Request cancelled.';
        emitStream(event, {
          streamId,
          sessionId: parsed.sessionId,
          type: 'status',
          text: 'Cancelled'
        });
      } else {
        const message = asMessage(error);
        logger.error('Completion request failed', { sessionId: parsed.sessionId, message });
        assistantContent = `Provider request failed: ${message}`;
        emitStream(event, {
          streamId,
          sessionId: parsed.sessionId,
          type: 'error',
          text: assistantContent
        });
      }
    }

    try {
      const assistantMessage = addMessage({
        sessionId: parsed.sessionId,
        role: 'assistant',
        content: assistantContent,
        inputTokens,
        outputTokens
      });

      let latestSession = getSessionById(parsed.sessionId) ?? session;
      const titleGenerationEligible =
        shouldGenerateSessionTitle &&
        assistantMessage.content.trim().length > 0 &&
        !/^provider request failed:/i.test(assistantMessage.content.trim()) &&
        !/^request cancelled\.?$/i.test(assistantMessage.content.trim());

      if (titleGenerationEligible) {
        try {
          const generatedTitle = await generateSessionTitle({
            providerId: session.provider_id,
            modelProfileId: session.model_profile_id,
            requestedModelId: parsed.modelId,
            userMessage: userMessage.content,
            assistantMessage: assistantMessage.content,
            signal: controller.signal
          });

          if (generatedTitle && generatedTitle !== latestSession.title) {
            latestSession = setSessionTitle({
              sessionId: parsed.sessionId,
              title: generatedTitle
            });
          }
        } catch (error) {
          logger.warn('Session title generation failed', {
            sessionId: parsed.sessionId,
            message: asMessage(error)
          });
        }
      }

      markProviderUsed(session.provider_id);
      recordUsageEvent({
        providerId: session.provider_id,
        sessionId: parsed.sessionId,
        messageId: assistantMessage.id,
        eventType: 'completion',
        inputTokens: inputTokens ?? Math.ceil(parsed.content.length / 4),
        outputTokens: outputTokens ?? Math.ceil(assistantMessage.content.length / 4),
        costMicrounits: 0
      });

      emitStream(event, {
        streamId,
        sessionId: parsed.sessionId,
        type: 'done'
      });

      logger.info('message.send', { sessionId: parsed.sessionId, streamId });

      return {
        userMessage: mapMessage(userMessage),
        assistantMessage: mapMessage(assistantMessage),
        session: mapSession(latestSession)
      };
    } finally {
      inflightRequests.delete(streamId);
    }
  });
};
