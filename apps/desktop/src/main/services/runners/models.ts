import { getModelProfileById, getSetting } from '../db';

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
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
