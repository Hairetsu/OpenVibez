import { ipcMain, type IpcMainInvokeEvent } from 'electron';
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
const HISTORY_WINDOW = 30;

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
      const history = listMessages(parsed.sessionId)
        .slice(-HISTORY_WINDOW)
        .map((message) => ({ role: message.role, content: message.content }));

      if (provider.auth_kind === 'oauth_subscription') {
        const login = await getCodexLoginStatus();
        if (!login.loggedIn) {
          throw new Error(
            'ChatGPT subscription is not connected yet. Use Connect ChatGPT in Settings, then run Check Support.'
          );
        }

        const workspaceId = parsed.workspaceId ?? session.workspace_id ?? null;
        const workspacePath = workspaceId ? getWorkspaceById(workspaceId)?.root_path : undefined;

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
        if (!secret) {
          throw new Error('No API key stored for this provider yet.');
        }

        if (provider.type === 'openai') {
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
