import { ipcMain } from 'electron';
import { createProvider, getProviderById, listModelProfilesByProvider, listProviders, replaceProviderModelProfiles } from '../services/db';
import { getSecret, setSecret } from '../services/keychain';
import { getCodexDeviceAuthState, getCodexLoginStatus, listCodexAvailableModels, startCodexDeviceAuth } from '../services/providers/codex';
import { listOpenAIModels, testOpenAIConnection } from '../services/providers/openai';
import {
  providerCreateSchema,
  providerIdSchema,
  providerModelsSchema,
  providerSecretSchema,
  providerSubscriptionStartSchema
} from './contracts';

const mapProvider = (row: {
  id: string;
  type: string;
  display_name: string;
  auth_kind: string;
  keychain_ref: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}) => ({
  id: row.id,
  type: row.type,
  displayName: row.display_name,
  authKind: row.auth_kind,
  keychainRef: row.keychain_ref,
  isActive: row.is_active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastUsedAt: row.last_used_at
});

const mapModelProfile = (row: {
  id: string;
  provider_id: string;
  model_id: string;
  label: string;
  is_default: number;
  updated_at: number;
}) => ({
  id: row.id,
  providerId: row.provider_id,
  modelId: row.model_id,
  label: row.label,
  isDefault: row.is_default === 1,
  updatedAt: row.updated_at
});

const syncModelsForProvider = async (
  provider: {
    id: string;
    type: string;
    auth_kind: string;
  },
  secret?: string
) => {
  if (provider.type !== 'openai') {
    return [] as ReturnType<typeof mapModelProfile>[];
  }

  const modelIds =
    provider.auth_kind === 'oauth_subscription'
      ? await listCodexAvailableModels()
      : await listOpenAIModels(secret ?? '');

  return replaceProviderModelProfiles(provider.id, modelIds).map(mapModelProfile);
};

export const registerProviderHandlers = (): void => {
  ipcMain.handle('provider:list', () => {
    return listProviders().map(mapProvider);
  });

  ipcMain.handle('provider:create', (_event, input) => {
    const parsed = providerCreateSchema.parse(input);
    const provider = createProvider(parsed);
    return mapProvider(provider);
  });

  ipcMain.handle('provider:saveSecret', async (_event, input) => {
    const parsed = providerSecretSchema.parse(input);
    const provider = getProviderById(parsed.providerId);
    if (!provider || !provider.keychain_ref) {
      throw new Error('Provider not found or invalid keychain reference');
    }

    await setSecret(provider.keychain_ref, parsed.secret);
    return { ok: true };
  });

  ipcMain.handle('provider:testConnection', async (_event, input) => {
    const parsed = providerIdSchema.parse(input);
    const provider = getProviderById(parsed.providerId);

    if (!provider || !provider.keychain_ref) {
      return { ok: false, reason: 'Provider not found' };
    }

    if (provider.auth_kind === 'oauth_subscription') {
      if (provider.type !== 'openai') {
        return { ok: false, reason: 'Subscription mode is currently wired only for OpenAI providers.' };
      }

      const status = await getCodexLoginStatus();
      if (!status.loggedIn) {
        return {
          ok: false,
          reason: status.detail
        };
      }

      const models = await syncModelsForProvider(provider);
      return {
        ok: true,
        status: 200,
        reason: 'ChatGPT subscription login detected via Codex.',
        models
      };
    }

    const secret = await getSecret(provider.keychain_ref);
    if (!secret) {
      return { ok: false, reason: 'No secret saved for provider' };
    }

    if (provider.type === 'openai') {
      const result = await testOpenAIConnection(secret);
      const models = result.ok ? await syncModelsForProvider(provider, secret) : [];
      return {
        ok: result.ok,
        status: result.status,
        reason: result.ok ? undefined : 'OpenAI connectivity test failed',
        models
      };
    }

    return { ok: true, status: 200 };
  });

  ipcMain.handle('provider:startSubscriptionLogin', async (_event, input) => {
    const parsed = providerSubscriptionStartSchema.parse(input);
    const provider = getProviderById(parsed.providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }
    if (provider.type !== 'openai' || provider.auth_kind !== 'oauth_subscription') {
      throw new Error('Provider is not configured for OpenAI subscription login.');
    }

    return startCodexDeviceAuth();
  });

  ipcMain.handle('provider:getSubscriptionLoginState', (_event) => {
    return getCodexDeviceAuthState();
  });

  ipcMain.handle('provider:listModels', (_event, input) => {
    const parsed = providerModelsSchema.parse(input);
    return listModelProfilesByProvider(parsed.providerId).map(mapModelProfile);
  });

  ipcMain.handle('provider:refreshModels', async (_event, input) => {
    const parsed = providerModelsSchema.parse(input);
    const provider = getProviderById(parsed.providerId);
    if (!provider || !provider.keychain_ref) {
      throw new Error('Provider not found.');
    }

    if (provider.auth_kind === 'oauth_subscription') {
      const login = await getCodexLoginStatus();
      if (!login.loggedIn) {
        throw new Error(login.detail);
      }

      return syncModelsForProvider(provider);
    }

    const secret = await getSecret(provider.keychain_ref);
    if (!secret) {
      throw new Error('No API key saved for this provider.');
    }

    return syncModelsForProvider(provider, secret);
  });
};
