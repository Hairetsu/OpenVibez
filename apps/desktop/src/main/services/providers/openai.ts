import OpenAI, { APIError } from 'openai';
import type { ResponseCreateParamsNonStreaming, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';

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

const mapRole = (role: HistoryMessage['role']): 'system' | 'user' | 'assistant' => {
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

const createClient = (apiKey: string): OpenAI => {
  return new OpenAI({
    apiKey,
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

export const createOpenAICompletion = async (input: OpenAICompletionInput): Promise<OpenAICompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Streaming response...' });

  const client = createClient(input.apiKey);
  const baseRequest = createRequestBody(input);

  let fullText = '';
  let model = input.model;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const streamRequest: ResponseCreateParamsStreaming = {
      ...baseRequest,
      stream: true
    };

    const stream = await client.responses.create(
      streamRequest,
      {
        signal: input.signal
      }
    );

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
  } catch (error) {
    throw new Error(asErrorMessage(error));
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

export const testOpenAIConnection = async (apiKey: string): Promise<{ ok: boolean; status: number }> => {
  const client = createClient(apiKey);

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
        status: error.status ?? 0
      };
    }

    return {
      ok: false,
      status: 0
    };
  }
};

const isUsefulModelId = (modelId: string): boolean => /^(gpt|o\d|codex)/i.test(modelId);

export const listOpenAIModels = async (apiKey: string): Promise<string[]> => {
  const client = createClient(apiKey);

  const page = await client.models.list().catch((error) => {
    throw new Error(asErrorMessage(error));
  });

  const modelIds = page.data
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter((modelId) => modelId.length > 0 && isUsefulModelId(modelId));

  return [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
};
