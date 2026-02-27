import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  addMessage,
  archiveSession,
  completeAssistantRun,
  createAssistantRun,
  createSession,
  failAssistantRun,
  getAssistantRunByClientRequest,
  getMessageById,
  getProviderById,
  getSessionById,
  getWorkspaceById,
  listMessages,
  listSessions,
  markAssistantRunUserMessage,
  markProviderUsed,
  recordUsageEvent,
  setSessionTitle,
  setSessionProvider
} from '../services/db';
import { getSecret } from '../services/keychain';
import { createCodexCompletion } from '../services/providers/codex';
import { createOllamaCompletion } from '../services/providers/ollama';
import { createOpenAICompletion } from '../services/providers/openai';
import { resolveOllamaModel, resolveOpenAIModel } from '../services/runners/models';
import { runCodexSubscription, runLocalOllama, runOpenAI } from '../services/runners';
import type { ProviderRunner, RunnerContext, RunnerEvent } from '../services/runners';
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

const HISTORY_WINDOW = 30;
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
  requestKey: string;
  controller: AbortController;
  cancel: () => void;
};

const inflightRequests = new Map<string, InflightRequest>();
const inflightRequestKeys = new Map<string, string>();

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
    trace?: { traceKind: 'thought' | 'plan' | 'action'; text: string; actionKind?: string };
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

const runnerForProvider = (input: { providerType: string; authKind: string }): ProviderRunner => {
  if (input.authKind === 'oauth_subscription') {
    return runCodexSubscription;
  }

  if (input.providerType === 'openai') {
    return runOpenAI;
  }

  if (input.providerType === 'local') {
    return runLocalOllama;
  }

  throw new Error(`Provider "${input.providerType}" is not wired yet in v1.`);
};

const makeRequestKey = (sessionId: string, clientRequestId: string): string => `${sessionId}::${clientRequestId}`;

const mapRunnerEventToStream = (
  event: IpcMainInvokeEvent,
  streamId: string,
  sessionId: string,
  input: RunnerEvent,
  onDelta: (delta: string) => void
): void => {
  if (input.type === 'status') {
    emitStream(event, {
      streamId,
      sessionId,
      type: 'status',
      text: input.text
    });
    return;
  }

  if (input.type === 'trace') {
    emitStream(event, {
      streamId,
      sessionId,
      type: 'trace',
      trace: {
        traceKind: input.trace.traceKind,
        text: input.trace.text,
        actionKind: input.trace.actionKind
      }
    });
    return;
  }

  onDelta(input.delta);
  emitStream(event, {
    streamId,
    sessionId,
    type: 'text_delta',
    text: input.delta
  });
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
    const clientRequestId = (parsed.clientRequestId ?? streamId).trim();
    const requestKey = makeRequestKey(parsed.sessionId, clientRequestId);

    const existingRun = getAssistantRunByClientRequest({
      sessionId: parsed.sessionId,
      clientRequestId
    });

    if (existingRun?.user_message_id && existingRun.assistant_message_id) {
      const userMessage = getMessageById(existingRun.user_message_id);
      const assistantMessage = getMessageById(existingRun.assistant_message_id);
      if (userMessage && assistantMessage) {
        return {
          userMessage: mapMessage(userMessage),
          assistantMessage: mapMessage(assistantMessage),
          session: mapSession(getSessionById(parsed.sessionId) ?? session)
        };
      }
    }

    if (existingRun && existingRun.status === 'running') {
      const activeStreamId = inflightRequestKeys.get(requestKey) ?? existingRun.stream_id;
      throw new Error(`Request already in progress for clientRequestId "${clientRequestId}" (stream ${activeStreamId}).`);
    }

    if (inflightRequestKeys.has(requestKey)) {
      throw new Error(`Request already in progress for clientRequestId "${clientRequestId}".`);
    }

    const run = (() => {
      try {
        return createAssistantRun({
          sessionId: parsed.sessionId,
          clientRequestId,
          streamId
        });
      } catch {
        const fromRace = getAssistantRunByClientRequest({
          sessionId: parsed.sessionId,
          clientRequestId
        });

        if (!fromRace) {
          throw new Error('Failed to create assistant run.');
        }

        if (fromRace.user_message_id && fromRace.assistant_message_id) {
          const userMessage = getMessageById(fromRace.user_message_id);
          const assistantMessage = getMessageById(fromRace.assistant_message_id);
          if (userMessage && assistantMessage) {
            return null;
          }
        }

        throw new Error(`Request already in progress for clientRequestId "${clientRequestId}".`);
      }
    })();

    if (!run) {
      const replay = getAssistantRunByClientRequest({
        sessionId: parsed.sessionId,
        clientRequestId
      });
      if (!replay?.user_message_id || !replay.assistant_message_id) {
        throw new Error('Unable to resolve idempotent replay for completed run.');
      }

      const userMessage = getMessageById(replay.user_message_id);
      const assistantMessage = getMessageById(replay.assistant_message_id);
      if (!userMessage || !assistantMessage) {
        throw new Error('Unable to resolve idempotent replay messages.');
      }

      return {
        userMessage: mapMessage(userMessage),
        assistantMessage: mapMessage(assistantMessage),
        session: mapSession(getSessionById(parsed.sessionId) ?? session)
      };
    }

    const controller = new AbortController();

    const inflight: InflightRequest = {
      streamId,
      requestKey,
      controller,
      cancel: () => {
        if (!controller.signal.aborted) {
          controller.abort(new RequestCancelledError());
        }
      }
    };
    inflightRequests.set(streamId, inflight);
    inflightRequestKeys.set(requestKey, streamId);

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
    markAssistantRunUserMessage({ runId: run.id, userMessageId: userMessage.id });

    let assistantContent = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let runErrorText: string | undefined;

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
      const workspace = workspaceId ? getWorkspaceById(workspaceId) : undefined;
      const effectiveAccessMode = parsed.accessMode ?? 'scoped';
      const history = [...existingMessages, userMessage]
        .slice(-HISTORY_WINDOW)
        .map((message) => ({ role: message.role, content: message.content }));

      const runner = runnerForProvider({
        providerType: provider.type,
        authKind: provider.auth_kind
      });

      const completion = await runner({
        provider,
        secret,
        modelProfileId: session.model_profile_id,
        requestedModelId: parsed.modelId,
        history,
        accessMode: effectiveAccessMode,
        workspace,
        signal: controller.signal,
        onEvent: (runnerEvent) => {
          mapRunnerEventToStream(event, streamId, parsed.sessionId, runnerEvent, (delta) => {
            assistantContent += delta;
          });
        }
      } satisfies RunnerContext);

      assistantContent = completion.text;
      inputTokens = completion.inputTokens;
      outputTokens = completion.outputTokens;
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
        runErrorText = assistantContent;
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

      completeAssistantRun({
        runId: run.id,
        assistantMessageId: assistantMessage.id,
        errorText: runErrorText
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

      logger.info('message.send', { sessionId: parsed.sessionId, streamId, clientRequestId });

      return {
        userMessage: mapMessage(userMessage),
        assistantMessage: mapMessage(assistantMessage),
        session: mapSession(latestSession)
      };
    } catch (error) {
      failAssistantRun({
        runId: run.id,
        errorText: asMessage(error)
      });
      throw error;
    } finally {
      inflightRequests.delete(streamId);
      inflightRequestKeys.delete(requestKey);
    }
  });
};
