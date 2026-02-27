import { createOpenAICompletion } from '../providers/openai';
import { resolveOpenAIModel } from './models';
import type { ProviderRunner } from './types';

export const runOpenAI: ProviderRunner = async (input) => {
  if (input.provider.type !== 'openai' || input.provider.auth_kind !== 'api_key') {
    throw new Error('OpenAI runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  const completion = await createOpenAICompletion({
    apiKey: input.secret,
    baseUrl: input.openaiOptions?.baseUrl,
    providerId: input.provider.id,
    model: resolveOpenAIModel(input.modelProfileId, input.requestedModelId),
    history: input.history,
    requestMeta: input.requestMeta,
    backgroundModeEnabled: input.openaiOptions?.backgroundModeEnabled,
    backgroundPollIntervalMs: input.openaiOptions?.backgroundPollIntervalMs,
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
