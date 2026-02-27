import { createOpenAICompletion, listOpenAIModels } from './openai';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export type OpenRouterPricingByModel = Record<string, { promptPerToken: number; completionPerToken: number }>;

type OpenRouterMeta = {
  appOrigin?: string;
  appTitle?: string;
};

type OpenRouterCompletionInput = {
  apiKey: string;
  model: string;
  history: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  pricingByModel?: OpenRouterPricingByModel;
  appOrigin?: string;
  appTitle?: string;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
};

type OpenRouterCompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
};

const buildOpenRouterHeaders = (meta?: OpenRouterMeta): Record<string, string> => {
  const headers: Record<string, string> = {};
  const appOrigin = meta?.appOrigin?.trim();
  const appTitle = meta?.appTitle?.trim();

  if (appOrigin) {
    headers['HTTP-Referer'] = appOrigin;
  }
  if (appTitle) {
    headers['X-Title'] = appTitle;
  }

  return headers;
};

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'OpenRouter request failed.';
};

const parseOpenRouterModelsError = async (res: Response): Promise<string> => {
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

  return `OpenRouter request failed (${res.status})`;
};

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

export const estimateOpenRouterCostMicrounits = (input: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  pricingByModel?: OpenRouterPricingByModel;
}): number | undefined => {
  const pricing = input.pricingByModel?.[input.model];
  if (!pricing) {
    return undefined;
  }

  const promptTokens = input.inputTokens ?? 0;
  const completionTokens = input.outputTokens ?? 0;
  const usdCost = promptTokens * pricing.promptPerToken + completionTokens * pricing.completionPerToken;
  if (!Number.isFinite(usdCost) || usdCost < 0) {
    return undefined;
  }

  return Math.max(0, Math.round(usdCost * 1_000_000));
};

export const testOpenRouterConnection = async (
  apiKey: string,
  meta?: OpenRouterMeta
): Promise<{ ok: boolean; status: number; reason?: string }> => {
  const headers = buildOpenRouterHeaders(meta);

  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...headers
      }
    });

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    return {
      ok: false,
      status: res.status,
      reason: await parseOpenRouterModelsError(res)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: asErrorMessage(error)
    };
  }
};

export const listOpenRouterModels = async (input: {
  apiKey: string;
  appOrigin?: string;
  appTitle?: string;
}): Promise<{
  modelIds: string[];
  pricingByModel: OpenRouterPricingByModel;
}> => {
  const headers = buildOpenRouterHeaders({
    appOrigin: input.appOrigin,
    appTitle: input.appTitle
  });

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        ...headers
      }
    });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseOpenRouterModelsError(res));
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        data?: Array<{
          id?: unknown;
          pricing?: { prompt?: unknown; completion?: unknown };
        }>;
      }
    | null;

  const fallbackModelIds = await listOpenAIModels(input.apiKey, OPENROUTER_BASE_URL, headers).catch(() => []);
  const modelIds = (payload?.data ?? [])
    .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  const pricingByModel: OpenRouterPricingByModel = {};
  for (const entry of payload?.data ?? []) {
    const modelId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!modelId) {
      continue;
    }

    const prompt = asFiniteNumber(entry?.pricing?.prompt);
    const completion = asFiniteNumber(entry?.pricing?.completion);
    if (prompt === null || completion === null || prompt < 0 || completion < 0) {
      continue;
    }

    pricingByModel[modelId] = {
      promptPerToken: prompt,
      completionPerToken: completion
    };
  }

  const resolvedModelIds = (modelIds.length > 0 ? modelIds : fallbackModelIds).sort((a, b) => a.localeCompare(b));
  return {
    modelIds: [...new Set(resolvedModelIds)],
    pricingByModel
  };
};

export const createOpenRouterCompletion = async (input: OpenRouterCompletionInput): Promise<OpenRouterCompletionResult> => {
  const headers = buildOpenRouterHeaders({
    appOrigin: input.appOrigin,
    appTitle: input.appTitle
  });

  const completion = await createOpenAICompletion({
    apiKey: input.apiKey,
    baseUrl: OPENROUTER_BASE_URL,
    extraHeaders: headers,
    model: input.model,
    history: input.history,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    backgroundModeEnabled: false,
    signal: input.signal,
    onEvent: input.onEvent
  });

  const costMicrounits = estimateOpenRouterCostMicrounits({
    model: completion.model,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    pricingByModel: input.pricingByModel
  });

  return {
    text: completion.text,
    model: completion.model,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    costMicrounits
  };
};
