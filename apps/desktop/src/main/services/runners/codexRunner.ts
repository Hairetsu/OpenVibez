import { createCodexCompletion, getCodexLoginStatus } from '../providers/codex';
import type { ProviderRunner } from './types';

export const runCodexSubscription: ProviderRunner = async (input) => {
  if (input.provider.type !== 'openai' || input.provider.auth_kind !== 'oauth_subscription') {
    throw new Error('Codex runner received incompatible provider configuration.');
  }

  const login = await getCodexLoginStatus();
  if (!login.loggedIn) {
    throw new Error(
      'ChatGPT subscription is not connected yet. Use Connect ChatGPT in Settings, then run Check Support.'
    );
  }

  const completion = await createCodexCompletion({
    history: input.history,
    cwd: input.workspace?.root_path,
    model: input.requestedModelId,
    fullAccess: input.accessMode === 'root',
    signal: input.signal,
    onEvent: (event) => {
      if (event.type === 'status' && event.text) {
        input.onEvent?.({ type: 'status', text: event.text });
        return;
      }

      if (event.type === 'trace') {
        input.onEvent?.({
          type: 'trace',
          trace: {
            traceKind: event.traceKind,
            text: event.text,
            actionKind: event.actionKind
          }
        });
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
