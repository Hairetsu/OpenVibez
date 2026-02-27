import { createOpenRouterCompletion } from '../providers/openrouter';
import { resolveOpenRouterModel } from './models';
import type { ProviderRunner } from './types';

export const runOpenRouter: ProviderRunner = async (input) => {
  if (input.provider.type !== 'openrouter' || input.provider.auth_kind !== 'api_key') {
    throw new Error('OpenRouter runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  const completion = await createOpenRouterCompletion({
    apiKey: input.secret,
    model: resolveOpenRouterModel(input.modelProfileId, input.requestedModelId),
    history: input.history,
    pricingByModel: input.openrouterOptions?.pricingByModel,
    appOrigin: input.openrouterOptions?.appOrigin,
    appTitle: input.openrouterOptions?.appTitle,
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
    outputTokens: completion.outputTokens,
    costMicrounits: completion.costMicrounits
  };
};
