type HistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

type GeminiCompletionInput = {
  apiKey: string;
  model: string;
  history: HistoryMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
};

type GeminiCompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const withGeminiModelPrefix = (model: string): string => (model.startsWith('models/') ? model : `models/${model}`);

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Gemini request failed.';
};

const parseJsonError = async (res: Response): Promise<string> => {
  const payload = (await res.json().catch(() => null)) as
    | { error?: { message?: unknown }; message?: unknown }
    | null;

  const message =
    typeof payload?.error?.message === 'string'
      ? payload.error.message
      : typeof payload?.message === 'string'
        ? payload.message
        : '';

  if (message.trim()) {
    return message.trim();
  }

  return `Gemini request failed (${res.status})`;
};

const mapHistoryToGemini = (
  history: HistoryMessage[]
): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
} => {
  const systemChunks: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const entry of history) {
    const text = entry.content.trim();
    if (!text) {
      continue;
    }

    if (entry.role === 'system') {
      systemChunks.push(text);
      continue;
    }

    contents.push({
      role: entry.role === 'user' ? 'user' : 'model',
      parts: [{ text }]
    });
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  }

  const system = systemChunks.join('\n\n').trim();
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents
  };
};

const buildGeminiUrl = (path: string, apiKey: string): string => {
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  return `${GEMINI_API_BASE}/${normalized}?key=${encodeURIComponent(apiKey)}`;
};

export const testGeminiConnection = async (
  apiKey: string
): Promise<{ ok: boolean; status: number; reason?: string }> => {
  try {
    const res = await fetch(buildGeminiUrl('models', apiKey), {
      method: 'GET'
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

export const listGeminiModels = async (apiKey: string): Promise<string[]> => {
  let res: Response;
  try {
    res = await fetch(buildGeminiUrl('models', apiKey), {
      method: 'GET'
    });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseJsonError(res));
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
      }
    | null;

  const modelIds = (payload?.models ?? [])
    .map((entry) => {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name.startsWith('models/')) {
        return '';
      }

      const supported = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
      const canGenerate = supported.some((method) => method === 'generateContent' || method === 'streamGenerateContent');
      if (!canGenerate) {
        return '';
      }

      return name.replace(/^models\//, '');
    })
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((a, b) => a.localeCompare(b));

  return modelIds;
};

export const createGeminiCompletion = async (input: GeminiCompletionInput): Promise<GeminiCompletionResult> => {
  input.onEvent?.({ type: 'status', text: 'Running Gemini response...' });

  const mapped = mapHistoryToGemini(input.history);
  const body: Record<string, unknown> = {
    contents: mapped.contents,
    ...(mapped.systemInstruction ? { systemInstruction: mapped.systemInstruction } : {})
  };

  const generationConfig: Record<string, unknown> = {};
  if (typeof input.temperature === 'number') {
    generationConfig.temperature = input.temperature;
  }
  if (typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens)) {
    generationConfig.maxOutputTokens = Math.max(1, Math.trunc(input.maxOutputTokens));
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  let res: Response;
  try {
    res = await fetch(buildGeminiUrl(`${withGeminiModelPrefix(input.model)}:generateContent`, input.apiKey), {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
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
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
        };
      }
    | null;

  const text = (payload?.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter((value) => value.length > 0)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  const inputTokens =
    typeof payload?.usageMetadata?.promptTokenCount === 'number' && Number.isFinite(payload.usageMetadata.promptTokenCount)
      ? payload.usageMetadata.promptTokenCount
      : undefined;
  const outputTokens =
    typeof payload?.usageMetadata?.candidatesTokenCount === 'number' &&
    Number.isFinite(payload.usageMetadata.candidatesTokenCount)
      ? payload.usageMetadata.candidatesTokenCount
      : undefined;

  input.onEvent?.({ type: 'assistant_delta', delta: text });
  return {
    text,
    model: input.model,
    inputTokens,
    outputTokens
  };
};
