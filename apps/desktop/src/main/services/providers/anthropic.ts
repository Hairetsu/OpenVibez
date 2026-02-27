type HistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

type AnthropicCompletionInput = {
  apiKey: string;
  model: string;
  history: HistoryMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
};

type AnthropicCompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 2048;

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Anthropic request failed.';
};

const parseJsonError = async (res: Response): Promise<string> => {
  const payload = (await res.json().catch(() => null)) as
    | { error?: { message?: unknown }; message?: unknown }
    | null;

  const message = typeof payload?.error?.message === 'string'
    ? payload.error.message
    : typeof payload?.message === 'string'
      ? payload.message
      : '';

  if (message.trim()) {
    return message.trim();
  }

  return `Anthropic request failed (${res.status})`;
};

const mapHistoryToAnthropic = (history: HistoryMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} => {
  const systemParts: string[] = [];
  const rawMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const entry of history) {
    const content = entry.content.trim();
    if (!content) {
      continue;
    }

    if (entry.role === 'system') {
      systemParts.push(content);
      continue;
    }

    rawMessages.push({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content
    });
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of rawMessages) {
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`.trim();
      continue;
    }
    messages.push(message);
  }

  if (messages.length === 0 || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: 'Continue.' });
  }
  if (messages[messages.length - 1]?.role !== 'user') {
    messages.push({ role: 'user', content: 'Continue.' });
  }

  const system = systemParts.join('\n\n').trim();
  return {
    ...(system ? { system } : {}),
    messages
  };
};

const anthropicHeaders = (apiKey: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': ANTHROPIC_VERSION
});

export const testAnthropicConnection = async (
  apiKey: string
): Promise<{ ok: boolean; status: number; reason?: string }> => {
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/models`, {
      method: 'GET',
      headers: anthropicHeaders(apiKey)
    });

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    return {
      ok: false,
      status: res.status,
      reason: await parseJsonError(res)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: asErrorMessage(error)
    };
  }
};

export const listAnthropicModels = async (apiKey: string): Promise<string[]> => {
  let res: Response;
  try {
    res = await fetch(`${ANTHROPIC_API_BASE}/v1/models`, {
      method: 'GET',
      headers: anthropicHeaders(apiKey)
    });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseJsonError(res));
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        data?: Array<{ id?: unknown }>;
      }
    | null;

  const modelIds = (payload?.data ?? [])
    .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((a, b) => a.localeCompare(b));

  return modelIds;
};

export const createAnthropicCompletion = async (input: AnthropicCompletionInput): Promise<AnthropicCompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Running Anthropic response...' });

  const mapped = mapHistoryToAnthropic(input.history);
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens:
      typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens)
        ? Math.max(1, Math.trunc(input.maxOutputTokens))
        : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
    messages: mapped.messages
  };

  if (mapped.system) {
    body.system = mapped.system;
  }

  if (typeof input.temperature === 'number') {
    body.temperature = input.temperature;
  }

  let res: Response;
  try {
    res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(input.apiKey),
      body: JSON.stringify(body),
      signal: input.signal
    });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseJsonError(res));
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        model?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      }
    | null;

  const text = (payload?.content ?? [])
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter((value) => value.length > 0)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Anthropic returned an empty response.');
  }

  const model = typeof payload?.model === 'string' && payload.model.trim() ? payload.model : input.model;
  const inputTokens =
    typeof payload?.usage?.input_tokens === 'number' && Number.isFinite(payload.usage.input_tokens)
      ? payload.usage.input_tokens
      : undefined;
  const outputTokens =
    typeof payload?.usage?.output_tokens === 'number' && Number.isFinite(payload.usage.output_tokens)
      ? payload.usage.output_tokens
      : undefined;

  input.onEvent?.({ type: 'assistant_delta', delta: text });
  return {
    text,
    model,
    inputTokens,
    outputTokens
  };
};
