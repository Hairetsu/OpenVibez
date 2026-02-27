import { createGeminiCompletion } from '../providers/gemini';
import { resolveGeminiModel } from './models';
import type { ProviderRunner } from './types';

export const runGemini: ProviderRunner = async (input) => {
  if (input.provider.type !== 'gemini' || input.provider.auth_kind !== 'api_key') {
    throw new Error('Gemini runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  const completion = await createGeminiCompletion({
    apiKey: input.secret,
    model: resolveGeminiModel(input.modelProfileId, input.requestedModelId),
    history: input.history,
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
