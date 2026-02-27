import { createOpenAICompletion } from '../providers/openai';
import { resolveGrokModel } from './models';
import type { ProviderRunner } from './types';

const GROK_API_BASE_URL = 'https://api.x.ai/v1';

export const runGrok: ProviderRunner = async (input) => {
  if (input.provider.type !== 'grok' || input.provider.auth_kind !== 'api_key') {
    throw new Error('Grok runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  input.onEvent?.({
    type: 'status',
    text: 'Grok provider is currently in chat mode (no autonomous local tool execution).'
  });

  const completion = await createOpenAICompletion({
    apiKey: input.secret,
    baseUrl: GROK_API_BASE_URL,
    providerId: input.provider.id,
    model: resolveGrokModel(input.modelProfileId, input.requestedModelId),
    history: input.history,
    requestMeta: input.requestMeta,
    backgroundModeEnabled: false,
    signal: input.signal,
    onEvent: (event) => {
      if (event.type === 'status' && event.text) {
        input.onEvent?.({ type: 'status', text: event.text });
        return;
      }

      if (event.type === 'assistant_delta' && event.delta) {
        input.onEvent?.({ type: 'assistant_delta', delta: event.delta });
      }
    }
  });

  return {
    text: completion.text,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens
  };
};
