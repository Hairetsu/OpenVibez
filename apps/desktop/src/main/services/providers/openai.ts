import OpenAI, { APIError } from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStatus
} from 'openai/resources/responses/responses';
import { updateBackgroundJob, upsertBackgroundJob } from '../db';

type HistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

type OpenAICompletionInput = {
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  providerId?: string;
  model: string;
  history: HistoryMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  requestMeta?: {
    runId: string;
    sessionId: string;
    clientRequestId: string;
  };
  backgroundModeEnabled?: boolean;
  backgroundPollIntervalMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
};

type OpenAICompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

type ResponseInputItem = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type OpenAIBackgroundJobPayload = {
  responseId: string;
  providerId: string;
  sessionId: string;
  runId: string;
  clientRequestId: string;
  model: string;
  status: string;
  updatedAt: number;
};

export type OpenAIBackgroundResponseSnapshot = {
  responseId: string;
  model: string;
  status?: ResponseStatus;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  errorText?: string;
};

const OPENAI_BACKGROUND_JOB_KIND = 'openai.response.poll';
const DEFAULT_BACKGROUND_POLL_INTERVAL_MS = 2000;

class OpenAIBackgroundUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIBackgroundUnsupportedError';
  }
}

const mapRole = (role: HistoryMessage['role']): 'system' | 'user' | 'assistant' => {
  if (role === 'tool') {
    return 'assistant';
  }

  return role;
};

const mapRoleForChatCompletions = (
  role: HistoryMessage['role']
): 'system' | 'user' | 'assistant' => {
  if (role === 'tool') {
    return 'assistant';
  }

  return role;
};

const parseTextFromResponse = (payload: {
  output_text?: string | null;
  output?: Array<{
    text?: string | null;
    content?: Array<{ text?: string | null }>;
  }>;
}): string => {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return '';
  }

  const chunks: string[] = [];
  for (const item of payload.output) {
    if (typeof item?.text === 'string') {
      chunks.push(item.text);
    }

    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const part of item.content) {
      if (typeof part?.text === 'string') {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join('\n').trim();
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return undefined;
};

const asErrorMessage = (error: unknown): string => {
  if (error instanceof APIError) {
    return error.message;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'OpenAI request failed.';
};

const isBackgroundUnsupportedError = (error: unknown, message: string): boolean => {
  const normalized = message.toLowerCase();
  const mentionsBackground = normalized.includes('background');
  const mentionsUnsupportedReason =
    /unsupported|not supported|unknown|invalid|unrecognized|not allowed|extra inputs are not permitted/.test(normalized);

  if (!mentionsBackground || !mentionsUnsupportedReason) {
    return false;
  }

  if (!(error instanceof APIError)) {
    return true;
  }

  const status = typeof error.status === 'number' ? error.status : 0;
  return status === 400 || status === 404 || status === 422 || status === 501;
};

const toAbortError = (message = 'Request cancelled by user.'): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw toAbortError();
  }
};

const sleepWithSignal = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const normalizeBaseUrl = (value?: string): string | undefined => {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }

  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid OpenAI-compatible base URL: "${raw}"`);
  }

  return parsed.toString().replace(/\/$/, '');
};

const isOfficialOpenAIBaseUrl = (baseUrl?: string): boolean => {
  if (!baseUrl) {
    return true;
  }

  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === 'api.openai.com';
  } catch {
    return false;
  }
};

const createClient = (apiKey: string, options?: {
  webhookSecret?: string | null;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}): OpenAI => {
  const normalizedBaseUrl = normalizeBaseUrl(options?.baseUrl);
  return new OpenAI({
    apiKey,
    webhookSecret: options?.webhookSecret ?? null,
    ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
    ...(options?.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
    maxRetries: 2,
    timeout: 60_000
  });
};

const createRequestBody = (input: OpenAICompletionInput): {
  model: string;
  input: ResponseInputItem[];
  temperature?: number;
  max_output_tokens?: number;
} => {
  const body: {
    model: string;
    input: ResponseInputItem[];
    temperature?: number;
    max_output_tokens?: number;
  } = {
    model: input.model,
    input: input.history.map((message) => ({
      role: mapRole(message.role),
      content: message.content
    }))
  };

  if (typeof input.temperature === 'number') {
    body.temperature = input.temperature;
  }

  if (typeof input.maxOutputTokens === 'number') {
    body.max_output_tokens = input.maxOutputTokens;
  }

  return body;
};

const isTerminalStatus = (status?: ResponseStatus): boolean => {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'incomplete';
};

const responseErrorText = (response: OpenAIResponse): string | undefined => {
  if (response.error?.message) {
    return response.error.message;
  }

  if (response.incomplete_details?.reason) {
    return `Response incomplete: ${response.incomplete_details.reason}`;
  }

  if (response.status === 'cancelled') {
    return 'Background response was cancelled.';
  }

  return undefined;
};

const snapshotFromResponse = (response: OpenAIResponse): OpenAIBackgroundResponseSnapshot => {
  return {
    responseId: response.id,
    model: typeof response.model === 'string' && response.model.trim() ? response.model : 'unknown',
    status: response.status,
    text: parseTextFromResponse({
      output_text: response.output_text,
      output: (response.output ?? []) as Array<{
        text?: string | null;
        content?: Array<{ text?: string | null }>;
      }>
    }),
    inputTokens: toFiniteNumber(response.usage?.input_tokens),
    outputTokens: toFiniteNumber(response.usage?.output_tokens),
    errorText: responseErrorText(response)
  };
};

const backgroundJobIdForRun = (runId: string): string => `job_openai_bg_${runId}`;

export const getOpenAIBackgroundJobKind = (): string => OPENAI_BACKGROUND_JOB_KIND;

export const isOpenAITerminalStatus = (status?: ResponseStatus): boolean => isTerminalStatus(status);

export const retrieveOpenAIBackgroundResponse = async (input: {
  apiKey: string;
  baseUrl?: string;
  responseId: string;
  signal?: AbortSignal;
}): Promise<OpenAIBackgroundResponseSnapshot> => {
  const client = createClient(input.apiKey, { baseUrl: input.baseUrl });
  const response = await client.responses
    .retrieve(input.responseId, undefined, { signal: input.signal })
    .catch((error) => {
      throw new Error(asErrorMessage(error));
    });

  return snapshotFromResponse(response as OpenAIResponse);
};

const runOpenAIStreaming = async (input: OpenAICompletionInput): Promise<OpenAICompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Streaming response...' });

  const client = createClient(input.apiKey, { baseUrl: input.baseUrl, defaultHeaders: input.extraHeaders });
  const baseRequest = createRequestBody(input);

  let fullText = '';
  let model = input.model;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const streamRequest: ResponseCreateParamsStreaming = {
    ...baseRequest,
    stream: true
  };

  const stream = await client.responses
    .create(streamRequest, {
      signal: input.signal
    })
    .catch((error) => {
      throw new Error(asErrorMessage(error));
    });

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      fullText += event.delta;
      input.onEvent?.({ type: 'assistant_delta', delta: event.delta });
      continue;
    }

    if (event.type === 'response.completed') {
      const response = event.response;
      if (typeof response?.model === 'string' && response.model.trim()) {
        model = response.model;
      }

      inputTokens = toFiniteNumber(response?.usage?.input_tokens);
      outputTokens = toFiniteNumber(response?.usage?.output_tokens);
    }
  }

  if (!fullText.trim()) {
    const fallbackRequest: ResponseCreateParamsNonStreaming = {
      ...baseRequest,
      stream: false
    };

    const fallback = await client.responses
      .create(fallbackRequest, {
        signal: input.signal
      })
      .catch((error) => {
        throw new Error(asErrorMessage(error));
      });

    if (typeof fallback.model === 'string' && fallback.model.trim()) {
      model = fallback.model;
    }

    fullText = parseTextFromResponse({
      output_text: fallback.output_text,
      output: (fallback.output ?? []) as Array<{
        text?: string | null;
        content?: Array<{ text?: string | null }>;
      }>
    });

    inputTokens = toFiniteNumber(fallback.usage?.input_tokens);
    outputTokens = toFiniteNumber(fallback.usage?.output_tokens);
  }

  if (!fullText.trim()) {
    throw new Error('OpenAI returned an empty response.');
  }

  return {
    text: fullText,
    model,
    inputTokens,
    outputTokens
  };
};

const runOpenAICompatibleChatStreaming = async (input: OpenAICompletionInput): Promise<OpenAICompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Streaming response...' });

  const client = createClient(input.apiKey, { baseUrl: input.baseUrl, defaultHeaders: input.extraHeaders });
  const messages = input.history.map((message) => ({
    role: mapRoleForChatCompletions(message.role),
    content: message.content
  }));

  let fullText = '';
  let model = input.model;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const stream = await client.chat.completions
    .create(
      {
        model: input.model,
        messages,
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
        ...(typeof input.maxOutputTokens === 'number' ? { max_tokens: input.maxOutputTokens } : {}),
        stream: true
      },
      { signal: input.signal }
    )
    .catch((error) => {
      throw new Error(asErrorMessage(error));
    });

  for await (const event of stream) {
    const delta = event.choices[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      fullText += delta;
      input.onEvent?.({ type: 'assistant_delta', delta });
    }
  }

  if (!fullText.trim()) {
    const fallback = await client.chat.completions
      .create(
        {
          model: input.model,
          messages,
          ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
          ...(typeof input.maxOutputTokens === 'number' ? { max_tokens: input.maxOutputTokens } : {}),
          stream: false
        },
        {
          signal: input.signal
        }
      )
      .catch((error) => {
        throw new Error(asErrorMessage(error));
      });

    model = typeof fallback.model === 'string' && fallback.model.trim() ? fallback.model : input.model;
    fullText = (fallback.choices ?? [])
      .map((choice) => (typeof choice.message?.content === 'string' ? choice.message.content : ''))
      .filter((value) => value.length > 0)
      .join('\n')
      .trim();

    inputTokens = toFiniteNumber(fallback.usage?.prompt_tokens);
    outputTokens = toFiniteNumber(fallback.usage?.completion_tokens);
  }

  if (!fullText.trim()) {
    throw new Error('OpenAI-compatible endpoint returned an empty response.');
  }

  return {
    text: fullText,
    model,
    inputTokens,
    outputTokens
  };
};

const runOpenAIBackground = async (input: OpenAICompletionInput): Promise<OpenAICompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Queued in background...' });

  const client = createClient(input.apiKey, { baseUrl: input.baseUrl, defaultHeaders: input.extraHeaders });
  const baseRequest = createRequestBody(input);
  const pollIntervalMs = Math.max(500, Math.trunc(input.backgroundPollIntervalMs ?? DEFAULT_BACKGROUND_POLL_INTERVAL_MS));

  const request: ResponseCreateParamsNonStreaming = {
    ...baseRequest,
    stream: false,
    background: true
  };

  throwIfAborted(input.signal);
  let initialResponse: OpenAIResponse;

  try {
    initialResponse = await client.responses.create(request, { signal: input.signal });
  } catch (error) {
    const message = asErrorMessage(error);
    if (isBackgroundUnsupportedError(error, message)) {
      throw new OpenAIBackgroundUnsupportedError(message);
    }

    throw new Error(message);
  }

  const initialSnapshot = snapshotFromResponse(initialResponse as OpenAIResponse);
  const backgroundJobId = input.requestMeta && input.providerId ? backgroundJobIdForRun(input.requestMeta.runId) : null;

  if (backgroundJobId && input.requestMeta && input.providerId) {
    upsertBackgroundJob({
      id: backgroundJobId,
      kind: OPENAI_BACKGROUND_JOB_KIND,
      state: isTerminalStatus(initialSnapshot.status) ? 'completed' : 'running',
      payload: {
        responseId: initialSnapshot.responseId,
        providerId: input.providerId,
        sessionId: input.requestMeta.sessionId,
        runId: input.requestMeta.runId,
        clientRequestId: input.requestMeta.clientRequestId,
        model: initialSnapshot.model,
        status: initialSnapshot.status ?? 'queued',
        updatedAt: Date.now()
      } satisfies OpenAIBackgroundJobPayload
    });
  }

  const persistJob = (payload: OpenAIBackgroundJobPayload, state?: 'running' | 'completed' | 'failed') => {
    if (!backgroundJobId) {
      return;
    }

    updateBackgroundJob({
      id: backgroundJobId,
      state: state ?? 'running',
      payload
    });
  };

  let snapshot = initialSnapshot;
  let attempts = 0;

  const updatePayload = (nextSnapshot: OpenAIBackgroundResponseSnapshot): OpenAIBackgroundJobPayload | null => {
    if (!input.requestMeta || !input.providerId) {
      return null;
    }

    return {
      responseId: nextSnapshot.responseId,
      providerId: input.providerId,
      sessionId: input.requestMeta.sessionId,
      runId: input.requestMeta.runId,
      clientRequestId: input.requestMeta.clientRequestId,
      model: nextSnapshot.model,
      status: nextSnapshot.status ?? 'queued',
      updatedAt: Date.now()
    };
  };

  try {
    while (!isTerminalStatus(snapshot.status)) {
      attempts += 1;
      input.onEvent?.({ type: 'status', text: `Background status: ${snapshot.status ?? 'queued'}...` });
      await sleepWithSignal(pollIntervalMs, input.signal);

      throwIfAborted(input.signal);
      snapshot = await retrieveOpenAIBackgroundResponse({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        responseId: snapshot.responseId,
        signal: input.signal
      });

      const payload = updatePayload(snapshot);
      if (payload) {
        persistJob(payload, 'running');
      }
    }

    if (snapshot.status !== 'completed') {
      throw new Error(snapshot.errorText ?? `OpenAI background response ended with status "${snapshot.status ?? 'unknown'}".`);
    }

    if (!snapshot.text.trim()) {
      throw new Error('OpenAI returned an empty background response.');
    }

    const payload = updatePayload(snapshot);
    if (payload) {
      persistJob(payload, 'completed');
    }

    input.onEvent?.({ type: 'status', text: 'Background response completed.' });
    input.onEvent?.({ type: 'assistant_delta', delta: snapshot.text });
    return {
      text: snapshot.text,
      model: snapshot.model,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens
    };
  } catch (error) {
    if (input.signal?.aborted) {
      try {
        await client.responses.cancel(snapshot.responseId);
      } catch {
        // ignore background cancel failures
      }

      const payload = updatePayload({
        ...snapshot,
        status: 'cancelled'
      });
      if (payload) {
        persistJob(payload, 'failed');
      }
      throw toAbortError();
    }

    const payload = updatePayload(snapshot);
    if (payload) {
      persistJob(payload, 'failed');
    }

    const message = error instanceof Error && error.message.trim() ? error.message : `OpenAI background polling failed after ${attempts} checks.`;
    throw new Error(message);
  }
};

export const createOpenAICompletion = async (input: OpenAICompletionInput): Promise<OpenAICompletionResult> => {
  if (!isOfficialOpenAIBaseUrl(input.baseUrl)) {
    input.onEvent?.({
      type: 'status',
      text: 'Using OpenAI-compatible endpoint...'
    });
    return runOpenAICompatibleChatStreaming(input);
  }

  if (input.backgroundModeEnabled) {
    try {
      return await runOpenAIBackground(input);
    } catch (error) {
      const message = asErrorMessage(error);
      if (!(error instanceof OpenAIBackgroundUnsupportedError)) {
        throw new Error(message);
      }

      input.onEvent?.({
        type: 'status',
        text: 'Background mode unavailable for this request. Falling back to streaming...'
      });
    }
  }

  return runOpenAIStreaming(input);
};

export const testOpenAIConnection = async (
  apiKey: string,
  baseUrl?: string,
  defaultHeaders?: Record<string, string>
): Promise<{ ok: boolean; status: number; reason?: string }> => {
  const client = createClient(apiKey, { baseUrl, defaultHeaders });

  try {
    await client.models.list();
    return {
      ok: true,
      status: 200
    };
  } catch (error) {
    if (error instanceof APIError) {
      return {
        ok: false,
        status: error.status ?? 0,
        reason: error.message
      };
    }

    return {
      ok: false,
      status: 0,
      reason: asErrorMessage(error)
    };
  }
};

const isUsefulModelId = (modelId: string): boolean => /^(gpt|o\d|codex)/i.test(modelId);

export const listOpenAIModels = async (
  apiKey: string,
  baseUrl?: string,
  defaultHeaders?: Record<string, string>
): Promise<string[]> => {
  const client = createClient(apiKey, { baseUrl, defaultHeaders });

  const page = await client.models.list().catch((error) => {
    throw new Error(asErrorMessage(error));
  });

  const modelIds = page.data
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter((modelId) => {
      if (modelId.length === 0) {
        return false;
      }

      if (!isOfficialOpenAIBaseUrl(baseUrl)) {
        return true;
      }

      return isUsefulModelId(modelId);
    });

  return [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
};

export const unwrapOpenAIWebhookEvent = async (input: {
  apiKey: string;
  payload: string;
  headers: Record<string, string | string[] | undefined>;
  webhookSecret: string;
}): Promise<{
  eventType: string;
  responseId?: string;
  createdAt?: number;
}> => {
  const client = createClient(input.apiKey, { webhookSecret: input.webhookSecret });
  const event = await client.webhooks.unwrap(input.payload, input.headers, input.webhookSecret);
  const normalized = event as { type?: unknown; created_at?: unknown; data?: { id?: unknown } };

  return {
    eventType: typeof normalized.type === 'string' ? normalized.type : 'unknown',
    responseId: typeof normalized.data?.id === 'string' ? normalized.data.id : undefined,
    createdAt: typeof normalized.created_at === 'number' ? normalized.created_at : undefined
  };
};
