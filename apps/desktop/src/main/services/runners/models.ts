import { getModelProfileById, getSetting } from '../db';

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_GROK_MODEL = 'grok-3-mini';
const DEFAULT_OPENROUTER_MODEL = 'x-ai/grok-3-mini';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:latest';

export const resolveOpenAIModel = (modelProfileId: string | null, requestedModelId?: string): string => {
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

export const resolveOllamaModel = (modelProfileId: string | null, requestedModelId?: string): string => {
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

export const resolveAnthropicModel = (modelProfileId: string | null, requestedModelId?: string): string => {
  if (requestedModelId && requestedModelId.trim()) {
    return requestedModelId;
  }

  if (modelProfileId) {
    const profile = getModelProfileById(modelProfileId);
    if (profile?.model_id) {
      return profile.model_id;
    }
  }

  return DEFAULT_ANTHROPIC_MODEL;
};

export const resolveGeminiModel = (modelProfileId: string | null, requestedModelId?: string): string => {
  if (requestedModelId && requestedModelId.trim()) {
    return requestedModelId;
  }

  if (modelProfileId) {
    const profile = getModelProfileById(modelProfileId);
    if (profile?.model_id) {
      return profile.model_id;
    }
  }

  return DEFAULT_GEMINI_MODEL;
};

export const resolveGrokModel = (modelProfileId: string | null, requestedModelId?: string): string => {
  if (requestedModelId && requestedModelId.trim()) {
    const candidate = requestedModelId.trim();
    if (/grok/i.test(candidate)) {
      return candidate;
    }
  }

  if (modelProfileId) {
    const profile = getModelProfileById(modelProfileId);
    if (profile?.model_id) {
      return profile.model_id;
    }
  }

  return DEFAULT_GROK_MODEL;
};

export const resolveOpenRouterModel = (modelProfileId: string | null, requestedModelId?: string): string => {
  if (requestedModelId && requestedModelId.trim()) {
    return requestedModelId;
  }

  if (modelProfileId) {
    const profile = getModelProfileById(modelProfileId);
    if (profile?.model_id) {
      return profile.model_id;
    }
  }

  return DEFAULT_OPENROUTER_MODEL;
};
