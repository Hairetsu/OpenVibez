import { createAnthropicCompletion } from '../providers/anthropic';
import { resolveAnthropicModel } from './models';
import type { ProviderRunner } from './types';

export const runAnthropic: ProviderRunner = async (input) => {
  if (input.provider.type !== 'anthropic' || input.provider.auth_kind !== 'api_key') {
    throw new Error('Anthropic runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  const completion = await createAnthropicCompletion({
    apiKey: input.secret,
    model: resolveAnthropicModel(input.modelProfileId, input.requestedModelId),
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
