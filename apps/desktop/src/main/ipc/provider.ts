import { ipcMain } from 'electron';
import {
  createProvider,
  getProviderById,
  getSetting,
  listModelProfilesByProvider,
  listProviders,
  replaceProviderModelProfiles,
  setSetting
} from '../services/db';
import { listAnthropicModels, testAnthropicConnection } from '../services/providers/anthropic';
import { listGeminiModels, testGeminiConnection } from '../services/providers/gemini';
import { getSecret, removeSecret, setSecret } from '../services/keychain';
import { getCodexDeviceAuthState, getCodexLoginStatus, listCodexAvailableModels, startCodexDeviceAuth } from '../services/providers/codex';
import { getOllamaDiagnostics, listOllamaModels, testOllamaConnection } from '../services/providers/ollama';
import { listOpenAIModels, testOpenAIConnection } from '../services/providers/openai';
import { listOpenRouterModels, testOpenRouterConnection } from '../services/providers/openrouter';
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

const openAIBaseUrlSettingKey = (providerId: string): string => `provider_openai_base_url:${providerId}`;
const openAICompatibleProfileIdSettingKey = (providerId: string): string => `provider_openai_compatible_profile_id:${providerId}`;
const openRouterPricingSettingKey = (providerId: string): string => `provider_openrouter_pricing:${providerId}`;
const openRouterAppOriginSettingKey = (providerId: string): string => `provider_openrouter_app_origin:${providerId}`;
const openRouterAppTitleSettingKey = (providerId: string): string => `provider_openrouter_app_title:${providerId}`;
const GROK_API_BASE_URL = 'https://api.x.ai/v1';

type OpenAICompatibleProfile = {
  id: string;
  baseUrl: string;
  isDefault?: boolean;
};

const asCompatibleProfiles = (value: unknown): OpenAICompatibleProfile[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles: OpenAICompatibleProfile[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const item = entry as { id?: unknown; baseUrl?: unknown; isDefault?: unknown };
    if (typeof item.id !== 'string' || typeof item.baseUrl !== 'string') {
      continue;
    }
    const id = item.id.trim();
    const baseUrl = item.baseUrl.trim();
    if (!id || !baseUrl) {
      continue;
    }
    profiles.push({
      id,
      baseUrl,
      isDefault: item.isDefault === true
    });
  }

  return profiles;
};

const resolveOpenAIBaseUrl = (providerId: string): string | undefined => {
  const profiles = asCompatibleProfiles(getSetting('openai_compatible_profiles'));
  const selectedProfileIdRaw = getSetting(openAICompatibleProfileIdSettingKey(providerId));
  const selectedProfileId = typeof selectedProfileIdRaw === 'string' ? selectedProfileIdRaw.trim() : '';
  if (selectedProfileId) {
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    if (selected?.baseUrl) {
      return selected.baseUrl;
    }
  }

  const explicitBaseUrlRaw = getSetting(openAIBaseUrlSettingKey(providerId));
  const explicitBaseUrl = typeof explicitBaseUrlRaw === 'string' ? explicitBaseUrlRaw.trim() : '';
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const defaultProfile = profiles.find((profile) => profile.isDefault);
  return defaultProfile?.baseUrl;
};

const syncModelsForProvider = async (
  provider: {
    id: string;
    type: string;
    auth_kind: string;
  },
  secret?: string,
  options?: {
    openaiBaseUrl?: string;
    openrouterAppOrigin?: string;
    openrouterAppTitle?: string;
  }
) => {
  if (provider.type === 'openai') {
    const modelIds =
      provider.auth_kind === 'oauth_subscription'
        ? await listCodexAvailableModels()
        : await listOpenAIModels(secret ?? '', options?.openaiBaseUrl);

    return replaceProviderModelProfiles(provider.id, modelIds).map(mapModelProfile);
  }

  if (provider.type === 'grok') {
    const modelIds = await listOpenAIModels(secret ?? '', GROK_API_BASE_URL);
    return replaceProviderModelProfiles(provider.id, modelIds).map(mapModelProfile);
  }

  if (provider.type === 'anthropic') {
    const modelIds = await listAnthropicModels(secret ?? '');
    return replaceProviderModelProfiles(provider.id, modelIds).map(mapModelProfile);
  }

  if (provider.type === 'gemini') {
    const modelIds = await listGeminiModels(secret ?? '');
    return replaceProviderModelProfiles(provider.id, modelIds).map(mapModelProfile);
  }

  if (provider.type === 'openrouter') {
    const result = await listOpenRouterModels({
      apiKey: secret ?? '',
      appOrigin: options?.openrouterAppOrigin,
      appTitle: options?.openrouterAppTitle
    });
    setSetting(openRouterPricingSettingKey(provider.id), result.pricingByModel);
    return replaceProviderModelProfiles(provider.id, result.modelIds).map(mapModelProfile);
  }

  if (provider.type === 'local') {
    const modelIds = await listOllamaModels(secret);
    return replaceProviderModelProfiles(provider.id, modelIds).map(mapModelProfile);
  }

  return [] as ReturnType<typeof mapModelProfile>[];
};

export const registerProviderHandlers = (): void => {
  ipcMain.handle('provider:list', () => {
    return listProviders().map(mapProvider);
  });

  ipcMain.handle('provider:create', (_event, input) => {
    const parsed = providerCreateSchema.parse(input);
    if (parsed.type !== 'openai' && parsed.authKind === 'oauth_subscription') {
      throw new Error('Subscription auth is currently supported only for OpenAI providers.');
    }
    const provider = createProvider(parsed);
    return mapProvider(provider);
  });

  ipcMain.handle('provider:saveSecret', async (_event, input) => {
    const parsed = providerSecretSchema.parse(input);
    const provider = getProviderById(parsed.providerId);
    if (!provider || !provider.keychain_ref) {
      throw new Error('Provider not found or invalid keychain reference');
    }

    const secret = parsed.secret.trim();
    if (secret) {
      await setSecret(provider.keychain_ref, secret);
    } else {
      await removeSecret(provider.keychain_ref);
    }

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

    if (provider.type === 'openai') {
      const secret = await getSecret(provider.keychain_ref);
      if (!secret) {
        return { ok: false, reason: 'No secret saved for provider' };
      }

      const openaiBaseUrl = resolveOpenAIBaseUrl(provider.id);

      const result = await testOpenAIConnection(secret, openaiBaseUrl);
      const models = result.ok ? await syncModelsForProvider(provider, secret, { openaiBaseUrl }) : [];
      return {
        ok: result.ok,
        status: result.status,
        reason: result.ok ? undefined : result.reason ?? 'OpenAI connectivity test failed',
        models
      };
    }

    if (provider.type === 'grok') {
      const secret = await getSecret(provider.keychain_ref);
      if (!secret) {
        return { ok: false, reason: 'No secret saved for provider' };
      }

      const result = await testOpenAIConnection(secret, GROK_API_BASE_URL);
      const models = result.ok ? await syncModelsForProvider(provider, secret) : [];
      return {
        ok: result.ok,
        status: result.status,
        reason: result.ok ? undefined : result.reason ?? 'Grok connectivity test failed',
        models
      };
    }

    if (provider.type === 'openrouter') {
      const secret = await getSecret(provider.keychain_ref);
      if (!secret) {
        return { ok: false, reason: 'No secret saved for provider' };
      }

      const appOriginRaw = getSetting(openRouterAppOriginSettingKey(provider.id));
      const appTitleRaw = getSetting(openRouterAppTitleSettingKey(provider.id));
      const appOrigin = typeof appOriginRaw === 'string' && appOriginRaw.trim() ? appOriginRaw.trim() : undefined;
      const appTitle = typeof appTitleRaw === 'string' && appTitleRaw.trim() ? appTitleRaw.trim() : undefined;

      const result = await testOpenRouterConnection(secret, { appOrigin, appTitle });
      const models = result.ok
        ? await syncModelsForProvider(provider, secret, {
          openrouterAppOrigin: appOrigin,
          openrouterAppTitle: appTitle
        })
        : [];

      return {
        ok: result.ok,
        status: result.status,
        reason: result.reason,
        models
      };
    }

    if (provider.type === 'anthropic') {
      const secret = await getSecret(provider.keychain_ref);
      if (!secret) {
        return { ok: false, reason: 'No secret saved for provider' };
      }

      const result = await testAnthropicConnection(secret);
      const models = result.ok ? await syncModelsForProvider(provider, secret) : [];
      return {
        ok: result.ok,
        status: result.status,
        reason: result.reason,
        models
      };
    }

    if (provider.type === 'gemini') {
      const secret = await getSecret(provider.keychain_ref);
      if (!secret) {
        return { ok: false, reason: 'No secret saved for provider' };
      }

      const result = await testGeminiConnection(secret);
      const models = result.ok ? await syncModelsForProvider(provider, secret) : [];
      return {
        ok: result.ok,
        status: result.status,
        reason: result.reason,
        models
      };
    }

    if (provider.type === 'local') {
      const endpoint = await getSecret(provider.keychain_ref);
      const result = await testOllamaConnection(endpoint ?? undefined);
      const models = result.ok ? await syncModelsForProvider(provider, endpoint ?? undefined) : [];
      return {
        ok: result.ok,
        status: result.status,
        reason: result.reason,
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
    if (provider.type === 'openai' && !secret) {
      throw new Error('No API key saved for this provider.');
    }
    if (provider.type === 'grok' && !secret) {
      throw new Error('No API key saved for this provider.');
    }
    if (provider.type === 'anthropic' && !secret) {
      throw new Error('No API key saved for this provider.');
    }
    if (provider.type === 'gemini' && !secret) {
      throw new Error('No API key saved for this provider.');
    }
    if (provider.type === 'openrouter' && !secret) {
      throw new Error('No API key saved for this provider.');
    }

    const openaiBaseUrl = provider.type === 'openai' ? resolveOpenAIBaseUrl(provider.id) : undefined;

    const openrouterAppOriginRaw =
      provider.type === 'openrouter' ? getSetting(openRouterAppOriginSettingKey(provider.id)) : null;
    const openrouterAppTitleRaw =
      provider.type === 'openrouter' ? getSetting(openRouterAppTitleSettingKey(provider.id)) : null;
    const openrouterAppOrigin =
      typeof openrouterAppOriginRaw === 'string' && openrouterAppOriginRaw.trim()
        ? openrouterAppOriginRaw.trim()
        : undefined;
    const openrouterAppTitle =
      typeof openrouterAppTitleRaw === 'string' && openrouterAppTitleRaw.trim()
        ? openrouterAppTitleRaw.trim()
        : undefined;

    return syncModelsForProvider(provider, secret ?? undefined, {
      openaiBaseUrl,
      openrouterAppOrigin,
      openrouterAppTitle
    });
  });

  ipcMain.handle('provider:localDiagnostics', async (_event, input) => {
    const parsed = providerIdSchema.parse(input);
    const provider = getProviderById(parsed.providerId);
    if (!provider || provider.type !== 'local' || !provider.keychain_ref) {
      throw new Error('Local provider not found.');
    }

    const endpoint = await getSecret(provider.keychain_ref);
    return getOllamaDiagnostics(endpoint ?? undefined);
  });
};
