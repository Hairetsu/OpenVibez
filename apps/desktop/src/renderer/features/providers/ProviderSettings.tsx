import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelProfile,
  Provider,
  ProviderSubscriptionLoginState,
} from "../../../preload/types";
import { api } from "../../shared/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import {
  Atom,
  Bot,
  BrainCircuit,
  ChevronDown,
  Orbit,
  Sparkles,
  SquareTerminal,
  Waypoints,
} from "lucide-react";

type ProviderSettingsProps = {
  providers: Provider[];
  activeProviderId: string | null;
  modelProfiles: ModelProfile[];
  selectedModelId: string;
  onModelChange: (modelId: string) => Promise<void>;
  onSelectProvider: (providerId: string) => Promise<void>;
  onCreateProvider: (input: {
    displayName: string;
    authKind: Provider["authKind"];
    type?: Provider["type"];
  }) => Promise<Provider>;
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

type ProviderSlot = {
  id:
    | "openai_api"
    | "openai_subscription"
    | "anthropic"
    | "gemini"
    | "openrouter"
    | "grok"
    | "local";
  title: string;
  description: string;
  type: Provider["type"];
  authKind: Provider["authKind"];
  defaultName: string;
  credentialLabel: string;
  credentialPlaceholder?: string;
};

type SlotVisual = {
  icon: typeof Sparkles;
  toneClassName: string;
};

const CHATGPT_SUBSCRIPTION_URL = "https://chatgpt.com";
const OPENAI_API_BILLING_URL =
  "https://platform.openai.com/settings/organization/billing/overview";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const GROK_OPENAI_BASE_URL = "https://api.x.ai/v1";

const PROVIDER_SLOTS: ProviderSlot[] = [
  {
    id: "openai_api",
    title: "OpenAI API",
    description: "Direct OpenAI key or compatible endpoint.",
    type: "openai",
    authKind: "api_key",
    defaultName: "OpenAI",
    credentialLabel: "API key",
    credentialPlaceholder: "sk-...",
  },
  {
    id: "openai_subscription",
    title: "ChatGPT",
    description: "Connect your ChatGPT subscription through Codex login.",
    type: "openai",
    authKind: "oauth_subscription",
    defaultName: "ChatGPT",
    credentialLabel: "Subscription",
  },
  {
    id: "anthropic",
    title: "Anthropic",
    description: "Claude API key connection.",
    type: "anthropic",
    authKind: "api_key",
    defaultName: "Anthropic",
    credentialLabel: "API key",
    credentialPlaceholder: "sk-ant-...",
  },
  {
    id: "gemini",
    title: "Gemini",
    description: "Native Gemini API connection.",
    type: "gemini",
    authKind: "api_key",
    defaultName: "Gemini",
    credentialLabel: "API key",
    credentialPlaceholder: "AIza...",
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    description: "OpenRouter API with pricing-aware model sync.",
    type: "openrouter",
    authKind: "api_key",
    defaultName: "OpenRouter",
    credentialLabel: "API key",
    credentialPlaceholder: "sk-or-...",
  },
  {
    id: "grok",
    title: "Grok",
    description: "Native xAI / Grok API connection.",
    type: "grok",
    authKind: "api_key",
    defaultName: "Grok",
    credentialLabel: "API key",
    credentialPlaceholder: "xai-...",
  },
  {
    id: "local",
    title: "Ollama",
    description: "Local endpoint and model runtime controls.",
    type: "local",
    authKind: "api_key",
    defaultName: "Ollama",
    credentialLabel: "Endpoint",
    credentialPlaceholder: DEFAULT_OLLAMA_ENDPOINT,
  },
];

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

const findProviderForSlot = (
  providers: Provider[],
  slot: ProviderSlot,
  preferredProviderId?: string | null,
): Provider | null => {
  if (preferredProviderId) {
    const preferred = providers.find((provider) => provider.id === preferredProviderId);
    if (
      preferred &&
      preferred.type === slot.type &&
      preferred.authKind === slot.authKind
    ) {
      return preferred;
    }
  }

  return (
    providers.find(
      (provider) =>
        provider.type === slot.type && provider.authKind === slot.authKind,
    ) ?? null
  );
};

const slotIdFromProvider = (provider: Provider | null): ProviderSlot["id"] => {
  if (!provider) {
    return "openai_api";
  }
  if (provider.type === "openai" && provider.authKind === "oauth_subscription") {
    return "openai_subscription";
  }
  if (provider.type === "anthropic") return "anthropic";
  if (provider.type === "gemini") return "gemini";
  if (provider.type === "openrouter") return "openrouter";
  if (provider.type === "grok") return "grok";
  if (provider.type === "local") return "local";
  return "openai_api";
};

const slotVisual = (slotId: ProviderSlot["id"]): SlotVisual => {
  switch (slotId) {
    case "openai_api":
      return {
        icon: Sparkles,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(63,182,255,0.18),rgba(63,182,255,0.03))] text-sky-200",
      };
    case "openai_subscription":
      return {
        icon: Bot,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(103,232,249,0.18),rgba(103,232,249,0.03))] text-cyan-200",
      };
    case "anthropic":
      return {
        icon: BrainCircuit,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(245,158,11,0.18),rgba(245,158,11,0.03))] text-amber-200",
      };
    case "gemini":
      return {
        icon: Sparkles,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(244,114,182,0.18),rgba(244,114,182,0.03))] text-rose-200",
      };
    case "openrouter":
      return {
        icon: Waypoints,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(129,140,248,0.18),rgba(129,140,248,0.03))] text-indigo-200",
      };
    case "grok":
      return {
        icon: Orbit,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(192,132,252,0.18),rgba(192,132,252,0.03))] text-fuchsia-200",
      };
    case "local":
      return {
        icon: SquareTerminal,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(74,222,128,0.18),rgba(74,222,128,0.03))] text-emerald-200",
      };
    default:
      return {
        icon: Atom,
        toneClassName:
          "bg-[linear-gradient(135deg,rgba(148,163,184,0.18),rgba(148,163,184,0.03))] text-slate-200",
      };
  }
};

export const ProviderSettings = ({
  providers,
  activeProviderId,
  modelProfiles,
  selectedModelId,
  onModelChange,
  onSelectProvider,
  onCreateProvider,
  onSaveSecret,
  onTestProvider,
  onOpenExternal,
  onStartSubscriptionLogin,
  onGetSubscriptionLoginState,
}: ProviderSettingsProps) => {
  const activeProvider = useMemo(
    () =>
      activeProviderId
        ? providers.find((provider) => provider.id === activeProviderId) ?? null
        : null,
    [activeProviderId, providers],
  );
  const [selectedSlotId, setSelectedSlotId] = useState<ProviderSlot["id"]>(
    slotIdFromProvider(activeProvider),
  );
  const [credentialValue, setCredentialValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
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
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const providerPickerRef = useRef<HTMLDivElement | null>(null);

  const selectedSlot = useMemo(
    () =>
      PROVIDER_SLOTS.find((slot) => slot.id === selectedSlotId) ??
      PROVIDER_SLOTS[0],
    [selectedSlotId],
  );
  const selectedProvider = useMemo(
    () => findProviderForSlot(providers, selectedSlot, activeProviderId),
    [providers, selectedSlot, activeProviderId],
  );
  const selectedSlotVisual = slotVisual(selectedSlot.id);

  useEffect(() => {
    if (!providerPickerOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!providerPickerRef.current) {
        return;
      }
      if (!providerPickerRef.current.contains(event.target as Node)) {
        setProviderPickerOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProviderPickerOpen(false);
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [providerPickerOpen]);

  useEffect(() => {
    if (activeProvider) {
      setSelectedSlotId(slotIdFromProvider(activeProvider));
    }
  }, [activeProvider]);

  useEffect(() => {
    if (!selectedProvider) {
      return;
    }
    if (selectedProvider.id === activeProviderId) {
      return;
    }
    void onSelectProvider(selectedProvider.id);
  }, [selectedProvider, activeProviderId, onSelectProvider]);

  useEffect(() => {
    setCredentialValue("");
    setStatus(null);
  }, [selectedSlotId]);

  useEffect(() => {
    const loadProviderExecutionControls = async () => {
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

      if (!selectedProvider) {
        setOpenaiSelectedProfileId("__custom__");
        setOpenaiBaseUrl("");
        setOpenrouterAppOrigin("");
        setOpenrouterAppTitle("OpenVibez");
        setOllamaTemperature("0.2");
        setOllamaMaxOutputTokens("1024");
        setOllamaNumCtx("8192");
        return;
      }

      if (selectedProvider.type === "openai") {
        const [
          baseUrlValue,
          profileIdValue,
          backgroundEnabled,
          backgroundPollInterval,
        ] = await Promise.all([
          api.settings.get({ key: openAIBaseUrlSettingKey(selectedProvider.id) }),
          api.settings.get({
            key: openAICompatibleProfileIdSettingKey(selectedProvider.id),
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

      if (selectedProvider.type === "openrouter") {
        const [originValue, titleValue] = await Promise.all([
          api.settings.get({
            key: openRouterAppOriginSettingKey(selectedProvider.id),
          }),
          api.settings.get({
            key: openRouterAppTitleSettingKey(selectedProvider.id),
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

      if (selectedProvider.type === "local") {
        const [tempValue, maxTokensValue, numCtxValue] = await Promise.all([
          api.settings.get({
            key: ollamaTemperatureSettingKey(selectedProvider.id),
          }),
          api.settings.get({
            key: ollamaMaxOutputTokensSettingKey(selectedProvider.id),
          }),
          api.settings.get({ key: ollamaNumCtxSettingKey(selectedProvider.id) }),
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
  }, [selectedProvider]);

  const ensureSelectedProvider = async (): Promise<Provider> => {
    if (selectedProvider) {
      return selectedProvider;
    }

    const created = await onCreateProvider({
      type: selectedSlot.type,
      displayName: selectedSlot.defaultName,
      authKind: selectedSlot.authKind,
    });
    await onSelectProvider(created.id);
    return created;
  };

  const runProviderTest = async (providerId: string) => {
    const result = await onTestProvider(providerId);
    setStatus(
      result.ok
        ? formatSuccessMessage(result.models)
        : `Failed (${result.status ?? "n/a"})${result.reason ? `: ${result.reason}` : ""}`,
    );
  };

  const onSubmitCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const provider = await ensureSelectedProvider();

    if (selectedSlot.type === "local") {
      await onSaveSecret(provider.id, credentialValue.trim());
      await runProviderTest(provider.id);
      return;
    }

    if (!credentialValue.trim()) {
      setStatus("Enter a key before saving.");
      return;
    }

    await onSaveSecret(provider.id, credentialValue.trim());
    await runProviderTest(provider.id);
    setCredentialValue("");
  };

  const onCheckSupport = async () => {
    const provider = await ensureSelectedProvider();
    await runProviderTest(provider.id);
  };

  const onConnectChatGPT = async () => {
    const provider = await ensureSelectedProvider();
    const nextState = await onStartSubscriptionLogin(provider.id);
    setSubscriptionState(nextState);

    if (nextState.status === "success") {
      await runProviderTest(provider.id);
      return;
    }

    if (nextState.verificationUri) {
      await onOpenExternal(nextState.verificationUri);
    }
    if (nextState.userCode) {
      setStatus(
        `Enter code ${nextState.userCode} in the browser, then click Check.`,
      );
    }
  };

  const onRefreshLoginState = async () => {
    const next = await onGetSubscriptionLoginState();
    setSubscriptionState(next);

    if (next.status === "success") {
      const provider = await ensureSelectedProvider();
      await runProviderTest(provider.id);
      return;
    }
    if (next.message) {
      setStatus(next.message);
    }
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
    if (!selectedProvider || selectedProvider.type !== "openai") {
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
        key: openAIBaseUrlSettingKey(selectedProvider.id),
        value: normalizedBaseUrl,
      }),
      api.settings.set({
        key: openAICompatibleProfileIdSettingKey(selectedProvider.id),
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
      existingByName ? `Updated profile "${name}".` : `Added profile "${name}".`,
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
    if (!selectedProvider || selectedProvider.type !== "openrouter") {
      return;
    }

    const appOrigin = openrouterAppOrigin.trim();
    if (appOrigin && !normalizeUrl(appOrigin)) {
      setStatus("OpenRouter app origin must be a valid URL.");
      return;
    }

    await Promise.all([
      api.settings.set({
        key: openRouterAppOriginSettingKey(selectedProvider.id),
        value: appOrigin,
      }),
      api.settings.set({
        key: openRouterAppTitleSettingKey(selectedProvider.id),
        value: openrouterAppTitle.trim(),
      }),
    ]);

    setStatus("Saved OpenRouter headers.");
  };

  const onSaveOllamaRuntimeControls = async () => {
    if (!selectedProvider || selectedProvider.type !== "local") {
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
        key: ollamaTemperatureSettingKey(selectedProvider.id),
        value: temp,
      }),
      api.settings.set({
        key: ollamaMaxOutputTokensSettingKey(selectedProvider.id),
        value: maxTokens,
      }),
      api.settings.set({
        key: ollamaNumCtxSettingKey(selectedProvider.id),
        value: numCtx,
      }),
    ]);

    setStatus("Saved Ollama runtime controls.");
  };

  const onRunOllamaDiagnostics = async () => {
    if (!selectedProvider || selectedProvider.type !== "local") {
      return;
    }

    const diagnostics = await api.provider.localDiagnostics({
      providerId: selectedProvider.id,
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
    <section className="grid gap-5">
      <div className="grid gap-1">
        <p className="display-font text-[11px] uppercase tracking-[0.18em] text-accent">
          Providers
        </p>
        <h3 className="text-base font-semibold text-foreground">Connections</h3>
        <p className="text-xs text-muted-foreground">
          One connection per provider type. Pick a provider, then add or change its key, login, or endpoint.
        </p>
      </div>

      <div className="border-b border-border/50 pb-4">
        <div className="grid gap-2">
          <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Provider
          </Label>
          <div className="relative" ref={providerPickerRef}>
            <button
              type="button"
              onClick={() => setProviderPickerOpen((open) => !open)}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-background/20 px-3 py-3 text-left transition-colors",
                providerPickerOpen
                  ? "border-primary/50 bg-background/35"
                  : "hover:border-border hover:bg-background/30",
              )}
            >
              <div
                className={cn(
                  "flex h-14 w-14 shrink-0 items-center justify-center rounded-[1.15rem] border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
                  selectedSlotVisual.toneClassName,
                )}
              >
                <selectedSlotVisual.icon className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm text-foreground">{selectedSlot.title}</strong>
                  <Badge variant={selectedProvider ? "default" : "outline"}>
                    {selectedProvider ? "Added" : "Not added"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedProvider?.displayName ?? selectedSlot.description}
                </p>
              </div>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  providerPickerOpen && "rotate-180",
                )}
              />
            </button>

            {providerPickerOpen && (
              <div className="absolute left-0 top-full z-20 mt-3 w-full rounded-[1.5rem] border border-border/70 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_40%),rgba(10,9,14,0.96)] p-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
                <div className="mb-3 flex items-center justify-between gap-2 px-1">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Choose provider
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      One connection slot per provider type.
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {PROVIDER_SLOTS.map((slot) => {
                    const provider = findProviderForSlot(providers, slot, activeProviderId);
                    const visual = slotVisual(slot.id);
                    const selected = slot.id === selectedSlotId;
                    const Icon = visual.icon;

                    return (
                      <button
                        key={slot.id}
                        type="button"
                        onClick={() => {
                          setSelectedSlotId(slot.id);
                          setProviderPickerOpen(false);
                        }}
                        className={cn(
                          "group grid min-h-[152px] grid-rows-[auto_1fr_auto] gap-3 rounded-[1.35rem] border p-3 text-left transition-all",
                          selected
                            ? "border-primary/60 bg-white/[0.06] shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
                            : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div
                            className={cn(
                              "flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
                              visual.toneClassName,
                            )}
                          >
                            <Icon className="h-4.5 w-4.5" strokeWidth={1.85} />
                          </div>
                          <Badge
                            variant={provider ? "default" : "outline"}
                            className="border-white/10 bg-black/20"
                          >
                            {provider ? "Added" : "New"}
                          </Badge>
                        </div>
                        <div className="min-w-0">
                          <strong className="block text-sm leading-tight text-foreground">
                            {slot.title}
                          </strong>
                          <span className="mt-2 block text-[11px] leading-relaxed text-muted-foreground">
                            {slot.description}
                          </span>
                        </div>
                        <div className="flex items-end justify-between gap-2">
                          <span className="truncate text-[11px] text-muted-foreground/90">
                            {provider?.displayName ?? "Not configured"}
                          </span>
                          <span
                            className={cn(
                              "h-2.5 w-2.5 rounded-full border border-white/20 transition-colors",
                              selected ? "bg-primary shadow-[0_0_18px_rgba(63,182,255,0.55)]" : "bg-transparent",
                            )}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-4 rounded-lg border border-border/50 bg-background/15 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{selectedSlot.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedSlot.description}
              </p>
            </div>
            <Badge variant={selectedProvider ? "default" : "outline"}>
              {selectedProvider ? "Change" : "Add"}
            </Badge>
          </div>

          {selectedSlot.type === "local" ? (
            <form onSubmit={onSubmitCredential} className="grid gap-2">
              <Label className="text-xs">Ollama endpoint (optional)</Label>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input
                  autoComplete="off"
                  value={credentialValue}
                  onChange={(e) => setCredentialValue(e.target.value)}
                  placeholder={DEFAULT_OLLAMA_ENDPOINT}
                />
                <Button type="submit">
                  {selectedProvider ? "Save + Test" : "Add + Test"}
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
          ) : selectedSlot.authKind === "api_key" ? (
            <form onSubmit={onSubmitCredential} className="grid gap-2">
              <Label className="text-xs">{selectedSlot.credentialLabel}</Label>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input
                  type="password"
                  autoComplete="off"
                  value={credentialValue}
                  onChange={(e) => setCredentialValue(e.target.value)}
                  placeholder={selectedSlot.credentialPlaceholder}
                />
                <Button type="submit">
                  {selectedProvider ? "Save + Test" : "Add + Test"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedProvider && (
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => void onCheckSupport()}
                  >
                    Refresh Models
                  </Button>
                )}
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
                  {selectedProvider ? "Reconnect ChatGPT" : "Connect ChatGPT"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void onRefreshLoginState()}
                >
                  Refresh
                </Button>
                {selectedProvider && (
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => void onCheckSupport()}
                  >
                    Check
                  </Button>
                )}
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
                  <span className="font-medium text-muted-foreground">Code: </span>
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

          {selectedProvider && modelProfiles.length > 0 && (
            <div className="grid gap-2 rounded-md border border-border/40 bg-background/25 p-2.5">
              <Label className="text-[11px]">Default model for this session</Label>
              <Select
                value={selectedModelId}
                onValueChange={(value) => {
                  void onModelChange(value);
                }}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {modelProfiles.map((model) => (
                    <SelectItem key={model.id} value={model.modelId}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {selectedProvider?.type === "openai" &&
            selectedProvider.authKind === "api_key" && (
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

          {selectedProvider?.type === "openrouter" && (
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

          {selectedProvider?.type === "grok" && (
            <p className="text-[11px] text-muted-foreground">
              Grok runs in autonomous tool mode using the same local command policy gates as other agents.
            </p>
          )}

          {selectedProvider?.type === "local" && (
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
            <Badge variant="outline" className="w-fit border-primary/30 bg-primary/5">
              {status}
            </Badge>
          )}
        </div>
      </div>
    </section>
  );
};
