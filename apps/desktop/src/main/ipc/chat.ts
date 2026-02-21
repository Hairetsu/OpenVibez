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
  recordUsageEvent
} from '../services/db';
import { getSecret } from '../services/keychain';
import { createCodexCompletion, getCodexLoginStatus } from '../services/providers/codex';
import { createOllamaCompletion } from '../services/providers/ollama';
import { createOpenAICompletion } from '../services/providers/openai';
import { logger } from '../util/logger';
import { messageListSchema, messageSendSchema, sessionArchiveSchema, sessionCreateSchema } from './contracts';

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
const MAX_LOCAL_TOOL_STEPS = 12;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_LIMIT = 20_000;

const asMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Unknown provider error';
};

const makeStreamId = (): string => `stream_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

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

type LocalToolCall = {
  name: 'run_shell';
  arguments: {
    command: string;
    cwd?: string;
  };
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
    `When you need to execute a shell command, respond with exactly one line:`,
    `${LOCAL_TOOL_CALL_PREFIX} {"name":"run_shell","arguments":{"command":"<shell command>","cwd":"<optional cwd>"}}`,
    'No markdown, no extra text when calling a tool.',
    '',
    'Available tools:',
    '- run_shell(command: string, cwd?: string): run a shell command and return stdout/stderr/exit code.',
    '',
    'Use tools whenever they help fulfill the request. You may call tools repeatedly until done.',
    `Access mode: ${input.accessMode}.`,
    context,
    'After tool results are returned, either call another tool or provide the final answer to the user.'
  ].join('\n');
};

const parseLocalToolCall = (text: string): LocalToolCall | null => {
  const trimmed = text.trim();
  const prefixIndex = trimmed.indexOf(LOCAL_TOOL_CALL_PREFIX);
  if (prefixIndex === -1) {
    return null;
  }

  const payloadText = trimmed.slice(prefixIndex + LOCAL_TOOL_CALL_PREFIX.length).trim();
  if (!payloadText) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }

  const parsed = payload as {
    name?: unknown;
    arguments?: { command?: unknown; cwd?: unknown };
  };

  if (parsed.name !== 'run_shell') {
    return null;
  }

  const command = typeof parsed.arguments?.command === 'string' ? parsed.arguments.command.trim() : '';
  if (!command) {
    return null;
  }

  const cwd = typeof parsed.arguments?.cwd === 'string' && parsed.arguments.cwd.trim()
    ? parsed.arguments.cwd.trim()
    : undefined;

  return {
    name: 'run_shell',
    arguments: {
      command,
      cwd
    }
  };
};

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

const runShellCommand = async (input: {
  command: string;
  cwd: string;
}): Promise<{
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> => {
  const command = normalizeMacUsersPath(input.command);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

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
      if (resolved) return;
      resolved = true;
      resolve({
        command,
        cwd: input.cwd,
        ...payload
      });
    };

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
      finish({
        ok: false,
        exitCode: null,
        timedOut,
        stdout,
        stderr: appendLimited(stderr, `\n${asMessage(error)}`)
      });
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
    cwd
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

  ipcMain.handle('message:send', async (event, input) => {
    const parsed = messageSendSchema.parse(input);
    const session = getSessionById(parsed.sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    const streamId = parsed.streamId ?? makeStreamId();

    emitStream(event, {
      streamId,
      sessionId: parsed.sessionId,
      type: 'status',
      text: 'Queued'
    });

    const userMessage = addMessage({
      sessionId: parsed.sessionId,
      role: 'user',
      content: parsed.content
    });

    let assistantContent = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const provider = getProviderById(session.provider_id);
      if (!provider) {
        throw new Error('Provider for this session could not be found.');
      }
      if (!provider.keychain_ref) {
        throw new Error('Provider has no keychain reference. Save your API key first.');
      }

      const secret = await getSecret(provider.keychain_ref);
      const workspaceId = parsed.workspaceId ?? session.workspace_id ?? null;
      const workspacePath = workspaceId ? getWorkspaceById(workspaceId)?.root_path : undefined;
      const effectiveAccessMode = parsed.accessMode ?? 'scoped';
      const history = listMessages(parsed.sessionId)
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

          for (let step = 0; step < MAX_LOCAL_TOOL_STEPS; step += 1) {
            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'status',
              text: step === 0 ? 'Planning next action...' : `Agent step ${step + 1}...`
            });

            const modelTurn = await createOllamaCompletion({
              baseUrl: secret ?? undefined,
              model,
              history: agentHistory,
              stream: false
            });

            totalInputTokens += modelTurn.inputTokens ?? 0;
            totalOutputTokens += modelTurn.outputTokens ?? 0;

            const toolCall = parseLocalToolCall(modelTurn.text);
            if (!toolCall) {
              finalResponse = modelTurn.text;
              break;
            }

            emitStream(event, {
              streamId,
              sessionId: parsed.sessionId,
              type: 'status',
              text: `Running command...`
            });

            const toolResult = await executeLocalToolCall({
              toolCall,
              workspacePath
            });

            agentHistory.push({ role: 'assistant', content: modelTurn.text });
            agentHistory.push({
              role: 'system',
              content: `TOOL_RESULT ${JSON.stringify(toolResult)}`
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

    const assistantMessage = addMessage({
      sessionId: parsed.sessionId,
      role: 'assistant',
      content: assistantContent,
      inputTokens,
      outputTokens
    });

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
      assistantMessage: mapMessage(assistantMessage)
    };
  });
};
