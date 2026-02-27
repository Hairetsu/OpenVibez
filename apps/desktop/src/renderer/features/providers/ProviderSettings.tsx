import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  ModelProfile,
  Provider,
  ProviderSubscriptionLoginState,
} from "../../../preload/types";
import { api } from "../../shared/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type ProviderSettingsProps = {
  providers: Provider[];
  activeProviderId: string | null;
  onSelectProvider: (providerId: string) => Promise<void>;
  onCreateProvider: (input: {
    displayName: string;
    authKind: Provider["authKind"];
    type?: Provider["type"];
  }) => Promise<void>;
  onSaveSecret: (
    providerId: string,
    secret: string,
  ) => Promise<{ ok: boolean }>;
  onTestProvider: (
    providerId: string,
  ) => Promise<{
    ok: boolean;
    status?: number;
    reason?: string;
    models?: ModelProfile[];
  }>;
  onOpenExternal: (url: string) => Promise<void>;
  onStartSubscriptionLogin: (
    providerId: string,
  ) => Promise<ProviderSubscriptionLoginState>;
  onGetSubscriptionLoginState: () => Promise<ProviderSubscriptionLoginState>;
};

const CHATGPT_SUBSCRIPTION_URL = "https://chatgpt.com";
const OPENAI_API_BILLING_URL =
  "https://platform.openai.com/settings/organization/billing/overview";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const GROK_OPENAI_BASE_URL = "https://api.x.ai/v1";
const openAIBaseUrlSettingKey = (providerId: string): string =>
  `provider_openai_base_url:${providerId}`;
const openAICompatibleProfileIdSettingKey = (providerId: string): string =>
  `provider_openai_compatible_profile_id:${providerId}`;
const openRouterAppOriginSettingKey = (providerId: string): string =>
  `provider_openrouter_app_origin:${providerId}`;
const openRouterAppTitleSettingKey = (providerId: string): string =>
  `provider_openrouter_app_title:${providerId}`;
const ollamaTemperatureSettingKey = (providerId: string): string =>
  `provider_ollama_temperature:${providerId}`;
const ollamaMaxOutputTokensSettingKey = (providerId: string): string =>
  `provider_ollama_max_output_tokens:${providerId}`;
const ollamaNumCtxSettingKey = (providerId: string): string =>
  `provider_ollama_num_ctx:${providerId}`;
type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
type OpenAICompatibleProfile = {
  id: string;
  name: string;
  baseUrl: string;
  isDefault: boolean;
};

const formatSuccessMessage = (models?: ModelProfile[]): string => {
  const count = models?.length ?? 0;
  return count > 0 ? `Connection OK (${count} models synced)` : "Connection OK";
};

const normalizeUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

const asCompatibleProfiles = (value: unknown): OpenAICompatibleProfile[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles: OpenAICompatibleProfile[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as {
      id?: unknown;
      name?: unknown;
      baseUrl?: unknown;
      isDefault?: unknown;
    };
    if (typeof item.id !== "string" || typeof item.baseUrl !== "string") {
      continue;
    }
    const id = item.id.trim();
    const normalized = normalizeUrl(item.baseUrl);
    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    const name = rawName || id;
    if (!id || !name || !normalized) {
      continue;
    }

    profiles.push({
      id,
      name,
      baseUrl: normalized,
      isDefault: item.isDefault === true,
    });
  }

  return profiles;
};

export const ProviderSettings = ({
  providers,
  activeProviderId,
  onSelectProvider,
  onCreateProvider,
  onSaveSecret,
  onTestProvider,
  onOpenExternal,
  onStartSubscriptionLogin,
  onGetSubscriptionLoginState,
}: ProviderSettingsProps) => {
  const [apiKey, setApiKey] = useState("");
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [newProviderName, setNewProviderName] = useState("OpenAI Primary");
  const [newProviderType, setNewProviderType] =
    useState<Provider["type"]>("openai");
  const [newAuthKind, setNewAuthKind] =
    useState<Provider["authKind"]>("api_key");
  const [subscriptionState, setSubscriptionState] =
    useState<ProviderSubscriptionLoginState | null>(null);
  const [codexApprovalPolicy, setCodexApprovalPolicy] =
    useState<CodexApprovalPolicy>("on-request");
  const [codexOutputSchema, setCodexOutputSchema] = useState("");
  const [codexSdkPilotEnabled, setCodexSdkPilotEnabled] = useState(false);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [openaiSelectedProfileId, setOpenaiSelectedProfileId] =
    useState("__custom__");
  const [openaiCompatibleProfiles, setOpenaiCompatibleProfiles] = useState<
    OpenAICompatibleProfile[]
  >([]);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileBaseUrl, setNewProfileBaseUrl] = useState("");
  const [newProfileDefault, setNewProfileDefault] = useState(false);
  const [openaiBackgroundModeEnabled, setOpenaiBackgroundModeEnabled] =
    useState(false);
  const [openaiBackgroundPollIntervalMs, setOpenaiBackgroundPollIntervalMs] =
    useState("2000");
  const [openrouterAppOrigin, setOpenrouterAppOrigin] = useState("");
  const [openrouterAppTitle, setOpenrouterAppTitle] = useState("OpenVibez");
  const [ollamaTemperature, setOllamaTemperature] = useState("0.2");
  const [ollamaMaxOutputTokens, setOllamaMaxOutputTokens] = useState("1024");
  const [ollamaNumCtx, setOllamaNumCtx] = useState("8192");

  useEffect(() => {
    if (
      newProviderType === "local" ||
      newProviderType === "anthropic" ||
      newProviderType === "gemini" ||
      newProviderType === "openrouter" ||
      newProviderType === "grok"
    ) {
      if (newAuthKind !== "api_key") {
        setNewAuthKind("api_key");
      }
      if (newProviderType === "local" && newProviderName === "OpenAI Primary") {
        setNewProviderName("Local Ollama");
      }
      if (
        newProviderType === "anthropic" &&
        newProviderName === "OpenAI Primary"
      ) {
        setNewProviderName("Anthropic Primary");
      }
      if (
        newProviderType === "gemini" &&
        newProviderName === "OpenAI Primary"
      ) {
        setNewProviderName("Gemini Primary");
      }
      if (
        newProviderType === "openrouter" &&
        newProviderName === "OpenAI Primary"
      ) {
        setNewProviderName("OpenRouter Primary");
      }
      if (
        newProviderType === "grok" &&
        newProviderName === "OpenAI Primary"
      ) {
        setNewProviderName("Grok Primary");
      }
      return;
    }

    if (
      newProviderType === "openai" &&
      (newProviderName === "Local Ollama" ||
        newProviderName === "Anthropic Primary" ||
        newProviderName === "Gemini Primary" ||
        newProviderName === "OpenRouter Primary" ||
        newProviderName === "Grok Primary")
    ) {
      setNewProviderName("OpenAI Primary");
    }
  }, [newAuthKind, newProviderName, newProviderType]);

  const resolvedActiveProviderId = useMemo(
    () =>
      activeProviderId &&
      providers.some((provider) => provider.id === activeProviderId)
        ? activeProviderId
        : (providers[0]?.id ?? ""),
    [activeProviderId, providers],
  );

  const activeProvider = useMemo(
    () =>
      providers.find((provider) => provider.id === resolvedActiveProviderId) ??
      null,
    [providers, resolvedActiveProviderId],
  );

  useEffect(() => {
    const loadProviderExecutionControls = async () => {
      if (!activeProvider) {
        setOpenaiBaseUrl("");
        return;
      }

      const [approval, schema, sdkPilot, profilesValue] = await Promise.all([
        api.settings.get({ key: "codex_approval_policy" }),
        api.settings.get({ key: "codex_output_schema_json" }),
        api.settings.get({ key: "codex_sdk_pilot_enabled" }),
        api.settings.get({ key: "openai_compatible_profiles" }),
      ]);

      const profiles = asCompatibleProfiles(profilesValue);
      setOpenaiCompatibleProfiles(profiles);

      if (
        approval === "untrusted" ||
        approval === "on-failure" ||
        approval === "on-request" ||
        approval === "never"
      ) {
        setCodexApprovalPolicy(approval);
      }

      setCodexOutputSchema(typeof schema === "string" ? schema : "");
      setCodexSdkPilotEnabled(sdkPilot === true);

      if (activeProvider.type === "openai") {
        const [
          baseUrlValue,
          profileIdValue,
          backgroundEnabled,
          backgroundPollInterval,
        ] = await Promise.all([
          api.settings.get({ key: openAIBaseUrlSettingKey(activeProvider.id) }),
          api.settings.get({
            key: openAICompatibleProfileIdSettingKey(activeProvider.id),
          }),
          api.settings.get({ key: "openai_background_mode_enabled" }),
          api.settings.get({ key: "openai_background_poll_interval_ms" }),
        ]);

        const selectedProfileId =
          typeof profileIdValue === "string" ? profileIdValue.trim() : "";
        const selectedProfile = selectedProfileId
          ? profiles.find((profile) => profile.id === selectedProfileId)
          : undefined;
        setOpenaiSelectedProfileId(
          selectedProfile ? selectedProfile.id : "__custom__",
        );
        setOpenaiBaseUrl(
          selectedProfile?.baseUrl ??
            (typeof baseUrlValue === "string" ? baseUrlValue : ""),
        );
        setOpenaiBackgroundModeEnabled(backgroundEnabled === true);
        setOpenaiBackgroundPollIntervalMs(
          typeof backgroundPollInterval === "number" &&
            Number.isFinite(backgroundPollInterval)
            ? String(Math.max(500, Math.trunc(backgroundPollInterval)))
            : "2000",
        );
      } else {
        setOpenaiSelectedProfileId("__custom__");
        setOpenaiBaseUrl("");
      }

      if (activeProvider.type === "openrouter") {
        const [originValue, titleValue] = await Promise.all([
          api.settings.get({
            key: openRouterAppOriginSettingKey(activeProvider.id),
          }),
          api.settings.get({
            key: openRouterAppTitleSettingKey(activeProvider.id),
          }),
        ]);
        setOpenrouterAppOrigin(
          typeof originValue === "string" ? originValue : "",
        );
        setOpenrouterAppTitle(
          typeof titleValue === "string" && titleValue.trim()
            ? titleValue
            : "OpenVibez",
        );
      } else {
        setOpenrouterAppOrigin("");
        setOpenrouterAppTitle("OpenVibez");
      }

      if (activeProvider.type === "local") {
        const [tempValue, maxTokensValue, numCtxValue] = await Promise.all([
          api.settings.get({
            key: ollamaTemperatureSettingKey(activeProvider.id),
          }),
          api.settings.get({
            key: ollamaMaxOutputTokensSettingKey(activeProvider.id),
          }),
          api.settings.get({ key: ollamaNumCtxSettingKey(activeProvider.id) }),
        ]);
        setOllamaTemperature(
          typeof tempValue === "number" && Number.isFinite(tempValue)
            ? String(tempValue)
            : "0.2",
        );
        setOllamaMaxOutputTokens(
          typeof maxTokensValue === "number" && Number.isFinite(maxTokensValue)
            ? String(Math.trunc(maxTokensValue))
            : "1024",
        );
        setOllamaNumCtx(
          typeof numCtxValue === "number" && Number.isFinite(numCtxValue)
            ? String(Math.trunc(numCtxValue))
            : "8192",
        );
      }
    };

    void loadProviderExecutionControls();
  }, [activeProvider]);

  const onCreate = async () => {
    if (!newProviderName.trim()) return;
    await onCreateProvider({
      type: newProviderType,
      displayName: newProviderName.trim(),
      authKind: newProviderType === "openai" ? newAuthKind : "api_key",
    });
    setStatus(`Created "${newProviderName.trim()}"`);
  };

  const onSubmitApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resolvedActiveProviderId || !apiKey.trim()) return;

    await onSaveSecret(resolvedActiveProviderId, apiKey.trim());
    const result = await onTestProvider(resolvedActiveProviderId);
    setStatus(
      result.ok
        ? formatSuccessMessage(result.models)
        : `Failed (${result.status ?? "n/a"})${result.reason ? `: ${result.reason}` : ""}`,
    );
  };

  const onSubmitLocalEndpoint = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resolvedActiveProviderId) return;

    await onSaveSecret(resolvedActiveProviderId, localEndpoint.trim());

    const result = await onTestProvider(resolvedActiveProviderId);
    setStatus(
      result.ok
        ? formatSuccessMessage(result.models)
        : `Failed (${result.status ?? "n/a"})${result.reason ? `: ${result.reason}` : ""}`,
    );
  };

  const onCheckSupport = async () => {
    if (!resolvedActiveProviderId) return;
    const result = await onTestProvider(resolvedActiveProviderId);
    setStatus(
      result.ok
        ? formatSuccessMessage(result.models)
        : `Failed (${result.status ?? "n/a"})${result.reason ? `: ${result.reason}` : ""}`,
    );
  };

  const onConnectChatGPT = async () => {
    if (!resolvedActiveProviderId) return;
    const nextState = await onStartSubscriptionLogin(resolvedActiveProviderId);
    setSubscriptionState(nextState);

    if (nextState.status === "success") {
      const result = await onTestProvider(resolvedActiveProviderId);
      setStatus(
        result.ok
          ? formatSuccessMessage(result.models)
          : `Failed (${result.status ?? "n/a"})`,
      );
      return;
    }

    if (nextState.verificationUri)
      await onOpenExternal(nextState.verificationUri);
    if (nextState.userCode)
      setStatus(
        `Enter code ${nextState.userCode} in the browser, then click Check Support.`,
      );
  };

  const onRefreshLoginState = async () => {
    const next = await onGetSubscriptionLoginState();
    setSubscriptionState(next);

    if (next.status === "success" && resolvedActiveProviderId) {
      const result = await onTestProvider(resolvedActiveProviderId);
      setStatus(
        result.ok
          ? formatSuccessMessage(result.models)
          : `Failed (${result.status ?? "n/a"})`,
      );
      return;
    }
    if (next.message) setStatus(next.message);
  };

  const onSaveCodexControls = async () => {
    if (codexOutputSchema.trim()) {
      try {
        const parsed = JSON.parse(codexOutputSchema);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setStatus("Schema must be a JSON object.");
          return;
        }
      } catch {
        setStatus("Schema must be valid JSON.");
        return;
      }
    }

    await Promise.all([
      api.settings.set({
        key: "codex_approval_policy",
        value: codexApprovalPolicy,
      }),
      api.settings.set({
        key: "codex_output_schema_json",
        value: codexOutputSchema.trim(),
      }),
      api.settings.set({
        key: "codex_sdk_pilot_enabled",
        value: codexSdkPilotEnabled,
      }),
    ]);

    setStatus("Saved Codex execution controls.");
  };

  const onSaveOpenAIBackgroundControls = async () => {
    if (!activeProvider || activeProvider.type !== "openai") {
      return;
    }

    const trimmed = openaiBackgroundPollIntervalMs.trim();
    const parsedPoll = Number.parseInt(trimmed || "0", 10);
    if (!Number.isFinite(parsedPoll) || parsedPoll < 500) {
      setStatus("Background poll interval must be a whole number >= 500ms.");
      return;
    }

    const rawBaseUrl = openaiBaseUrl.trim();
    const normalizedBaseUrl = rawBaseUrl ? normalizeUrl(rawBaseUrl) : "";
    if (rawBaseUrl && !normalizedBaseUrl) {
      setStatus("OpenAI-compatible base URL must be a valid URL.");
      return;
    }
    const selectedProfile =
      openaiSelectedProfileId !== "__custom__"
        ? openaiCompatibleProfiles.find(
            (profile) => profile.id === openaiSelectedProfileId,
          )
        : undefined;

    await Promise.all([
      api.settings.set({
        key: openAIBaseUrlSettingKey(activeProvider.id),
        value: normalizedBaseUrl,
      }),
      api.settings.set({
        key: openAICompatibleProfileIdSettingKey(activeProvider.id),
        value: selectedProfile?.id ?? "",
      }),
      api.settings.set({
        key: "openai_background_mode_enabled",
        value: openaiBackgroundModeEnabled,
      }),
      api.settings.set({
        key: "openai_background_poll_interval_ms",
        value: parsedPoll,
      }),
    ]);

    setStatus("Saved OpenAI provider controls.");
  };

  const onAddOrUpdateCompatibleProfile = async () => {
    const name = newProfileName.trim();
    const normalizedBaseUrl = normalizeUrl(newProfileBaseUrl);
    if (!name || !normalizedBaseUrl) {
      setStatus("Profile name and a valid URL are required.");
      return;
    }

    const existingByName = openaiCompatibleProfiles.find(
      (profile) => profile.name.toLowerCase() === name.toLowerCase(),
    );
    const updatedProfiles = existingByName
      ? openaiCompatibleProfiles.map((profile) =>
          profile.id === existingByName.id
            ? {
                ...profile,
                name,
                baseUrl: normalizedBaseUrl,
                isDefault: newProfileDefault || profile.isDefault,
              }
            : {
                ...profile,
                isDefault: newProfileDefault ? false : profile.isDefault,
              },
        )
      : [
          ...openaiCompatibleProfiles.map((profile) => ({
            ...profile,
            isDefault: newProfileDefault ? false : profile.isDefault,
          })),
          {
            id: `prof_${Date.now().toString(36)}`,
            name,
            baseUrl: normalizedBaseUrl,
            isDefault: newProfileDefault,
          },
        ];

    await api.settings.set({
      key: "openai_compatible_profiles",
      value: updatedProfiles,
    });

    setOpenaiCompatibleProfiles(updatedProfiles);
    setNewProfileName("");
    setNewProfileBaseUrl("");
    setNewProfileDefault(false);
    setStatus(
      existingByName
        ? `Updated profile "${name}".`
        : `Added profile "${name}".`,
    );
  };

  const onDeleteCompatibleProfile = async (profileId: string) => {
    const remaining = openaiCompatibleProfiles.filter(
      (profile) => profile.id !== profileId,
    );
    await api.settings.set({
      key: "openai_compatible_profiles",
      value: remaining,
    });
    setOpenaiCompatibleProfiles(remaining);
    if (openaiSelectedProfileId === profileId) {
      setOpenaiSelectedProfileId("__custom__");
    }
    setStatus("Removed endpoint profile.");
  };

  const onSetDefaultCompatibleProfile = async (profileId: string) => {
    const updated = openaiCompatibleProfiles.map((profile) => ({
      ...profile,
      isDefault: profile.id === profileId,
    }));
    await api.settings.set({
      key: "openai_compatible_profiles",
      value: updated,
    });
    setOpenaiCompatibleProfiles(updated);
    setStatus("Updated default endpoint profile.");
  };

  const onSaveOpenRouterControls = async () => {
    if (!activeProvider || activeProvider.type !== "openrouter") {
      return;
    }

    const appOrigin = openrouterAppOrigin.trim();
    if (appOrigin && !normalizeUrl(appOrigin)) {
      setStatus("OpenRouter app origin must be a valid URL.");
      return;
    }

    await Promise.all([
      api.settings.set({
        key: openRouterAppOriginSettingKey(activeProvider.id),
        value: appOrigin,
      }),
      api.settings.set({
        key: openRouterAppTitleSettingKey(activeProvider.id),
        value: openrouterAppTitle.trim(),
      }),
    ]);

    setStatus("Saved OpenRouter headers.");
  };

  const onSaveOllamaRuntimeControls = async () => {
    if (!activeProvider || activeProvider.type !== "local") {
      return;
    }

    const temp = Number.parseFloat(ollamaTemperature.trim());
    const maxTokens = Number.parseInt(ollamaMaxOutputTokens.trim(), 10);
    const numCtx = Number.parseInt(ollamaNumCtx.trim(), 10);

    if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
      setStatus("Ollama temperature must be a number between 0 and 2.");
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      setStatus("Ollama max output tokens must be a whole number >= 1.");
      return;
    }
    if (!Number.isFinite(numCtx) || numCtx < 256) {
      setStatus("Ollama context window must be a whole number >= 256.");
      return;
    }

    await Promise.all([
      api.settings.set({
        key: ollamaTemperatureSettingKey(activeProvider.id),
        value: temp,
      }),
      api.settings.set({
        key: ollamaMaxOutputTokensSettingKey(activeProvider.id),
        value: maxTokens,
      }),
      api.settings.set({
        key: ollamaNumCtxSettingKey(activeProvider.id),
        value: numCtx,
      }),
    ]);

    setStatus("Saved Ollama runtime controls.");
  };

  const onRunOllamaDiagnostics = async () => {
    if (!activeProvider || activeProvider.type !== "local") {
      return;
    }

    const diagnostics = await api.provider.localDiagnostics({
      providerId: activeProvider.id,
    });
    if (!diagnostics.reachable) {
      setStatus(
        `Diagnostics failed: ${diagnostics.error ?? `status ${diagnostics.tagsStatus}`}`,
      );
      return;
    }

    setStatus(
      `Ollama ${diagnostics.version ?? "unknown"} | ${diagnostics.modelCount} models | ${diagnostics.runningModelCount} running | ${diagnostics.latencyMs}ms`,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Providers</CardTitle>
        <CardDescription>
          Link API keys or ChatGPT subscription to sync models.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label className="text-xs">New provider</Label>
          <div className="grid gap-2 sm:grid-cols-[1fr_140px_160px_auto]">
            <Input
              value={newProviderName}
              onChange={(e) => setNewProviderName(e.target.value)}
              placeholder="Label"
            />
            <Select
              value={newProviderType}
              onValueChange={(v) => setNewProviderType(v as Provider["type"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
                <SelectItem value="grok">Grok (xAI)</SelectItem>
                <SelectItem value="local">Local (Ollama)</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={newAuthKind}
              onValueChange={(v) => setNewAuthKind(v as Provider["authKind"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="api_key">API Key</SelectItem>
                {newProviderType === "openai" && (
                  <SelectItem value="oauth_subscription">
                    Subscription
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              type="button"
              onClick={() => void onCreate()}
            >
              Add
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-xs">Active provider</Label>
          <Select
            value={resolvedActiveProviderId || "__none__"}
            onValueChange={(v) => {
              if (v === "__none__") {
                return;
              }
              setStatus(null);
              void onSelectProvider(v);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {providers.length === 0 && (
                <SelectItem value="__none__">No providers</SelectItem>
              )}
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayName} [
                  {p.type === "local"
                    ? "Local"
                    : p.authKind === "api_key"
                      ? "Key"
                      : "Sub"}
                  ]
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeProvider?.type === "local" ? (
          <form onSubmit={onSubmitLocalEndpoint} className="grid gap-2">
            <Label className="text-xs">Ollama endpoint (optional)</Label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                autoComplete="off"
                value={localEndpoint}
                onChange={(e) => setLocalEndpoint(e.target.value)}
                placeholder={DEFAULT_OLLAMA_ENDPOINT}
              />
              <Button type="submit">
                {localEndpoint.trim() ? "Save + Test" : "Test Default"}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void onCheckSupport()}
              >
                Refresh Models
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank to use {DEFAULT_OLLAMA_ENDPOINT}.
            </p>
          </form>
        ) : activeProvider?.authKind === "api_key" ? (
          <form onSubmit={onSubmitApiKey} className="grid gap-2">
            <Label className="text-xs">API key</Label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
              <Button type="submit">Save + Test</Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
            <p className="text-xs text-muted-foreground">
              Use your ChatGPT subscription via Codex device login.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="button"
                onClick={() => void onConnectChatGPT()}
              >
                Connect ChatGPT
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void onRefreshLoginState()}
              >
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void onCheckSupport()}
              >
                Check
              </Button>
            </div>
            {subscriptionState?.verificationUri && (
              <div className="text-xs">
                <span className="font-medium text-muted-foreground">URL: </span>
                <span className="break-all text-foreground/70">
                  {subscriptionState.verificationUri}
                </span>
              </div>
            )}
            {subscriptionState?.userCode && (
              <div className="text-xs">
                <span className="font-medium text-muted-foreground">
                  Code:{" "}
                </span>
                <span>{subscriptionState.userCode}</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => void onOpenExternal(CHATGPT_SUBSCRIPTION_URL)}
              >
                Open ChatGPT
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => void onOpenExternal(OPENAI_API_BILLING_URL)}
              >
                API Billing
              </Button>
            </div>

            <div className="grid gap-2 rounded-md border border-border/40 bg-background/30 p-2.5">
              <Label className="text-[11px]">Codex approval policy</Label>
              <Select
                value={codexApprovalPolicy}
                onValueChange={(value) =>
                  setCodexApprovalPolicy(value as CodexApprovalPolicy)
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="untrusted">untrusted</SelectItem>
                  <SelectItem value="on-failure">on-failure</SelectItem>
                  <SelectItem value="on-request">on-request</SelectItem>
                  <SelectItem value="never">never</SelectItem>
                </SelectContent>
              </Select>

              <Label className="text-[11px]">
                Output schema JSON (optional)
              </Label>
              <Textarea
                value={codexOutputSchema}
                onChange={(e) => setCodexOutputSchema(e.target.value)}
                placeholder='{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}'
                className="min-h-[84px] font-mono text-[11px]"
              />
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={codexSdkPilotEnabled}
                  onChange={(e) => setCodexSdkPilotEnabled(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Enable Codex SDK pilot (CLI remains fallback)
              </label>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void onSaveCodexControls()}
                >
                  Save Codex Controls
                </Button>
              </div>
            </div>
          </div>
        )}

        {activeProvider?.type === "openai" &&
          activeProvider.authKind === "api_key" && (
            <div className="grid gap-2 rounded-md border border-border/40 bg-background/30 p-2.5">
              <Label className="text-[11px]">Endpoint profile</Label>
              <Select
                value={openaiSelectedProfileId}
                onValueChange={(value) => {
                  setOpenaiSelectedProfileId(value);
                  if (value === "__custom__") {
                    return;
                  }
                  const profile = openaiCompatibleProfiles.find(
                    (entry) => entry.id === value,
                  );
                  if (profile) {
                    setOpenaiBaseUrl(profile.baseUrl);
                  }
                }}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__custom__">Custom URL</SelectItem>
                  {openaiCompatibleProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-[11px]">API base URL (optional)</Label>
              <Input
                value={openaiBaseUrl}
                onChange={(e) => {
                  setOpenaiSelectedProfileId("__custom__");
                  setOpenaiBaseUrl(e.target.value);
                }}
                placeholder="https://api.openai.com/v1"
                className="h-8"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setOpenaiSelectedProfileId("__custom__");
                    setOpenaiBaseUrl("");
                  }}
                >
                  OpenAI default
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setOpenaiSelectedProfileId("__custom__");
                    setOpenaiBaseUrl(OPENROUTER_BASE_URL);
                  }}
                >
                  OpenRouter
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setOpenaiSelectedProfileId("__custom__");
                    setOpenaiBaseUrl(GEMINI_OPENAI_BASE_URL);
                  }}
                >
                  Gemini (OpenAI API)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setOpenaiSelectedProfileId("__custom__");
                    setOpenaiBaseUrl(GROK_OPENAI_BASE_URL);
                  }}
                >
                  Grok (xAI)
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Configure OpenRouter or another OpenAI-compatible endpoint.
              </p>

              <div className="grid gap-2 rounded-md border border-border/40 bg-background/20 p-2">
                <Label className="text-[11px]">Save endpoint profile</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="Profile name (e.g. Grok)"
                    className="h-8"
                  />
                  <Input
                    value={newProfileBaseUrl}
                    onChange={(e) => setNewProfileBaseUrl(e.target.value)}
                    placeholder="https://api.x.ai/v1"
                    className="h-8"
                  />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newProfileDefault}
                    onChange={(e) => setNewProfileDefault(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Make this profile the default fallback
                </label>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => void onAddOrUpdateCompatibleProfile()}
                  >
                    Save Profile
                  </Button>
                </div>
                {openaiCompatibleProfiles.length > 0 && (
                  <div className="grid gap-1">
                    {openaiCompatibleProfiles.map((profile) => (
                      <div
                        key={profile.id}
                        className="flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="truncate text-muted-foreground">
                          {profile.name} — {profile.baseUrl}
                        </span>
                        <div className="flex gap-1">
                          {!profile.isDefault && (
                            <Button
                              size="sm"
                              variant="ghost"
                              type="button"
                              onClick={() =>
                                void onSetDefaultCompatibleProfile(profile.id)
                              }
                            >
                              Default
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() =>
                              void onDeleteCompatibleProfile(profile.id)
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Label className="text-[11px]">
                OpenAI long-run background mode
              </Label>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={openaiBackgroundModeEnabled}
                  onChange={(e) =>
                    setOpenaiBackgroundModeEnabled(e.target.checked)
                  }
                  className="h-3.5 w-3.5"
                />
                Enable background response mode (Phase 3 pilot)
              </label>

              <Label className="text-[11px]">
                Background poll interval (ms)
              </Label>
              <Input
                value={openaiBackgroundPollIntervalMs}
                onChange={(e) =>
                  setOpenaiBackgroundPollIntervalMs(e.target.value)
                }
                placeholder="2000"
                className="h-8"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void onSaveOpenAIBackgroundControls()}
                >
                  Save OpenAI Controls
                </Button>
              </div>
            </div>
          )}

        {activeProvider?.type === "openrouter" && (
          <div className="grid gap-2 rounded-md border border-border/40 bg-background/30 p-2.5">
            <Label className="text-[11px]">
              OpenRouter app origin (optional)
            </Label>
            <Input
              value={openrouterAppOrigin}
              onChange={(e) => setOpenrouterAppOrigin(e.target.value)}
              placeholder="https://openvibez.local"
              className="h-8"
            />
            <Label className="text-[11px]">
              OpenRouter app title (optional)
            </Label>
            <Input
              value={openrouterAppTitle}
              onChange={(e) => setOpenrouterAppTitle(e.target.value)}
              placeholder="OpenVibez"
              className="h-8"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void onSaveOpenRouterControls()}
              >
                Save OpenRouter Controls
              </Button>
            </div>
          </div>
        )}

        {activeProvider?.type === "grok" && (
          <p className="text-[11px] text-muted-foreground">
            Grok runs in autonomous tool mode using the same local command policy gates as other agents (workspace trust, scoped/root access, and high-risk command blocking).
          </p>
        )}

        {activeProvider?.type === "local" && (
          <div className="grid gap-2 rounded-md border border-border/40 bg-background/30 p-2.5">
            <Label className="text-[11px]">Ollama temperature</Label>
            <Input
              value={ollamaTemperature}
              onChange={(e) => setOllamaTemperature(e.target.value)}
              className="h-8"
            />
            <Label className="text-[11px]">Ollama max output tokens</Label>
            <Input
              value={ollamaMaxOutputTokens}
              onChange={(e) => setOllamaMaxOutputTokens(e.target.value)}
              className="h-8"
            />
            <Label className="text-[11px]">
              Ollama context window (`num_ctx`)
            </Label>
            <Input
              value={ollamaNumCtx}
              onChange={(e) => setOllamaNumCtx(e.target.value)}
              className="h-8"
            />
            <div className="flex justify-between">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void onRunOllamaDiagnostics()}
              >
                Run Diagnostics
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void onSaveOllamaRuntimeControls()}
              >
                Save Ollama Controls
              </Button>
            </div>
          </div>
        )}

        {status && (
          <Badge variant="outline" className="w-fit">
            {status}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
};
