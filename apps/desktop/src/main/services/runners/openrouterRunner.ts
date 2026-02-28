import { createOpenRouterCompletion } from '../providers/openrouter';
import { resolveOpenRouterModel } from './models';
import type { ProviderRunner } from './types';
import { RequestCancelledError, runToolProtocolAgent } from './toolProtocol';

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'OpenRouter request failed.';
};

const runOpenRouterCompletion = async (input: Parameters<ProviderRunner>[0], onEvent?: (event:
  | { type: 'status'; text: string }
  | { type: 'assistant_delta'; delta: string }) => void) => {
  return createOpenRouterCompletion({
    apiKey: input.secret!,
    model: resolveOpenRouterModel(input.modelProfileId, input.requestedModelId),
    history: input.history,
    pricingByModel: input.openrouterOptions?.pricingByModel,
    appOrigin: input.openrouterOptions?.appOrigin,
    appTitle: input.openrouterOptions?.appTitle,
    signal: input.signal,
    onEvent: (event) => {
      if (event.type === 'status' && event.text) {
        onEvent?.({ type: 'status', text: event.text });
        return;
      }

      if (event.type === 'assistant_delta' && event.delta) {
        onEvent?.({ type: 'assistant_delta', delta: event.delta });
      }
    }
  });
};

export const runOpenRouter: ProviderRunner = async (input) => {
  if (input.provider.type !== 'openrouter' || input.provider.auth_kind !== 'api_key') {
    throw new Error('OpenRouter runner received incompatible provider configuration.');
  }

  if (!input.secret) {
    throw new Error('No API key stored for this provider yet.');
  }

  const apiKey = input.secret;

  try {
    return await runToolProtocolAgent({
      providerLabel: 'OpenRouter',
      history: input.history,
      accessMode: input.accessMode,
      workspace: input.workspace,
      signal: input.signal,
      onEvent: input.onEvent,
      runCompletion: async (toolInput) => {
        const completion = await createOpenRouterCompletion({
          apiKey,
          model: resolveOpenRouterModel(input.modelProfileId, input.requestedModelId),
          history: toolInput.history,
          pricingByModel: input.openrouterOptions?.pricingByModel,
          appOrigin: input.openrouterOptions?.appOrigin,
          appTitle: input.openrouterOptions?.appTitle,
          signal: toolInput.signal,
          onEvent: (event) => {
            if (event.type === 'assistant_delta' && event.delta) {
              toolInput.onEvent?.({ type: 'assistant_delta', delta: event.delta });
            }
          }
        });

        return {
          text: completion.text,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costMicrounits: completion.costMicrounits
        };
      }
    });
  } catch (error) {
    if (error instanceof RequestCancelledError) {
      throw error;
    }

    const message = asErrorMessage(error);
    const likelyProtocolMiss =
      /protocol|tool|step_done|tool_call|final|max tool steps|failed to produce a valid execution plan/i.test(message);
    if (!likelyProtocolMiss) {
      throw error;
    }

    input.onEvent?.({ type: 'status', text: 'Falling back to direct OpenRouter response...' });
  }

  const completion = await runOpenRouterCompletion(input, (event) => {
    input.onEvent?.(event);
  });

  return {
    text: completion.text,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    costMicrounits: completion.costMicrounits
  };
};
