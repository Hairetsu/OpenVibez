import { listOpenAIModels } from './openai';

export const GROK_API_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_GROK_MODEL = 'grok-3-mini';

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Grok request failed.';
};

const parseJsonError = async (res: Response): Promise<string> => {
  const payload = (await res.json().catch(() => null)) as
    | { error?: { message?: unknown } | string; message?: unknown }
    | null;

  const errorField = payload?.error;
  if (typeof errorField === 'string' && errorField.trim()) {
    return errorField.trim();
  }
  if (errorField && typeof errorField === 'object' && typeof errorField.message === 'string' && errorField.message.trim()) {
    return errorField.message.trim();
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  return `Grok request failed (${res.status})`;
};

export const listGrokModels = async (apiKey: string): Promise<string[]> => {
  try {
    const listed = await listOpenAIModels(apiKey, GROK_API_BASE_URL);
    const filtered = listed.filter((modelId) => /grok/i.test(modelId));
    if (filtered.length > 0) {
      return filtered;
    }
  } catch {
    // Fall back to default model when /models is unavailable.
  }

  return [DEFAULT_GROK_MODEL];
};

export const testGrokConnection = async (
  apiKey: string
): Promise<{ ok: boolean; status: number; reason?: string }> => {
  try {
    const res = await fetch(`${GROK_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_GROK_MODEL,
        messages: [{ role: 'user', content: 'Respond exactly with: OK' }],
        max_tokens: 8,
        temperature: 0
      })
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
