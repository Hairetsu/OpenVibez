type HistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

type OpenAICompletionInput = {
  apiKey: string;
  model: string;
  history: HistoryMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
};

type OpenAICompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

const parseTextFromResponse = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const response = payload as {
    output_text?: unknown;
    output?: Array<{
      content?: Array<{ text?: unknown }>;
      text?: unknown;
    }>;
  };

  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return '';
  }

  const chunks: string[] = [];
  for (const item of response.output) {
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

const parseUsage = (payload: unknown): { inputTokens?: number; outputTokens?: number } => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') {
    return {};
  }

  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    return undefined;
  };

  return {
    inputTokens: toNumber(usage.input_tokens) ?? toNumber(usage.prompt_tokens),
    outputTokens: toNumber(usage.output_tokens) ?? toNumber(usage.completion_tokens)
  };
};

const mapRole = (role: HistoryMessage['role']): 'system' | 'user' | 'assistant' => {
  if (role === 'tool') {
    return 'assistant';
  }

  return role;
};

const createRequestBody = (input: OpenAICompletionInput): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: input.model,
    stream: true,
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

export const createOpenAICompletion = async (input: OpenAICompletionInput): Promise<OpenAICompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Streaming response...' });

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify(createRequestBody(input))
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const reason = payload?.error?.message ?? `OpenAI request failed (${res.status})`;
    throw new Error(reason);
  }

  if (!res.body) {
    throw new Error('OpenAI response body is unavailable for streaming.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let fullText = '';
  let model = input.model;
  let usage: { inputTokens?: number; outputTokens?: number } = {};

  const processData = (data: string): void => {
    if (!data || data === '[DONE]') {
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    const parsed = event as {
      type?: string;
      delta?: string;
      model?: string;
      response?: {
        model?: string;
        usage?: Record<string, unknown>;
        output_text?: string;
      };
    };

    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      model = parsed.model;
    }

    if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      fullText += parsed.delta;
      input.onEvent?.({ type: 'assistant_delta', delta: parsed.delta });
      return;
    }

    if (parsed.type === 'response.completed' && parsed.response) {
      if (typeof parsed.response.model === 'string' && parsed.response.model.trim()) {
        model = parsed.response.model;
      }

      usage = parseUsage({ usage: parsed.response.usage });

      if (!fullText && typeof parsed.response.output_text === 'string' && parsed.response.output_text.trim()) {
        fullText = parsed.response.output_text;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = rawEvent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim());

      const dataPayload = dataLines.join('');
      processData(dataPayload);
      boundary = buffer.indexOf('\n\n');
    }
  }

  const remaining = buffer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('');

  processData(remaining);

  if (!fullText.trim()) {
    const fallback = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({ ...createRequestBody(input), stream: false })
    });

    const payload = (await fallback.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!fallback.ok) {
      const reason = payload?.error?.message ?? `OpenAI fallback request failed (${fallback.status})`;
      throw new Error(reason);
    }

    fullText = parseTextFromResponse(payload);
    usage = parseUsage(payload);
  }

  if (!fullText.trim()) {
    throw new Error('OpenAI returned an empty response.');
  }

  return {
    text: fullText,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens
  };
};

export const testOpenAIConnection = async (apiKey: string): Promise<{ ok: boolean; status: number }> => {
  const res = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  return {
    ok: res.ok,
    status: res.status
  };
};

const isUsefulModelId = (modelId: string): boolean => /^(gpt|o\d|codex)/i.test(modelId);

export const listOpenAIModels = async (apiKey: string): Promise<string[]> => {
  const res = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    throw new Error(`OpenAI model list request failed (${res.status})`);
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        data?: Array<{ id?: unknown }>;
      }
    | null;

  const modelIds = (payload?.data ?? [])
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter((modelId) => modelId.length > 0 && isUsefulModelId(modelId));

  return modelIds.sort((a, b) => a.localeCompare(b));
};
