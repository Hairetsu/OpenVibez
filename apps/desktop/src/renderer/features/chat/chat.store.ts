import { nanoid } from 'nanoid';
import { create } from 'zustand';
import type {
  ModelProfile,
  Message,
  MessageAccessMode,
  MessageStreamEvent,
  MessageStreamTrace,
  Provider,
  ProviderSubscriptionLoginState,
  Session,
  Workspace
} from '../../../preload/types';
import { api } from '../../shared/api/client';

type StreamingState = {
  active: boolean;
  streamId: string | null;
  text: string;
  traces: MessageStreamTrace[];
  status: string | null;
};

type ChatState = {
  ready: boolean;
  loading: boolean;
  providers: Provider[];
  sessions: Session[];
  workspaces: Workspace[];
  modelProfiles: ModelProfile[];
  messages: Message[];
  selectedSessionId: string | null;
  selectedWorkspaceId: string | null;
  selectedModelId: string;
  accessMode: MessageAccessMode;
  usageSummary: { inputTokens: number; outputTokens: number; costMicrounits: number } | null;
  streaming: StreamingState;
  initialize: () => Promise<void>;
  createProvider: (input: { displayName: string; authKind: Provider['authKind']; type?: Provider['type'] }) => Promise<void>;
  createSession: (title: string) => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelMessage: () => Promise<void>;
  saveProviderSecret: (providerId: string, secret: string) => Promise<{ ok: boolean }>;
  testProvider: (providerId: string) => Promise<{ ok: boolean; status?: number; reason?: string; models?: ModelProfile[] }>;
  addWorkspace: (path: string) => Promise<void>;
  setSelectedWorkspaceId: (workspaceId: string | null) => Promise<void>;
  setSelectedModelId: (modelId: string) => Promise<void>;
  setAccessMode: (mode: MessageAccessMode) => void;
  openExternal: (url: string) => Promise<void>;
  startSubscriptionLogin: (providerId: string) => Promise<ProviderSubscriptionLoginState>;
  getSubscriptionLoginState: () => Promise<ProviderSubscriptionLoginState>;
};

const DEFAULT_MODEL_ID = 'gpt-4o-mini';
const CANCEL_WAIT_TIMEOUT_MS = 4000;

let streamUnsubscribe: (() => void) | null = null;

const pickProviderId = (providers: Provider[]): string | null => providers[0]?.id ?? null;

const getActiveProviderId = (state: Pick<ChatState, 'sessions' | 'selectedSessionId' | 'providers'>): string | null => {
  const sessionProviderId = state.sessions.find((session) => session.id === state.selectedSessionId)?.providerId;
  return sessionProviderId ?? state.providers[0]?.id ?? null;
};

const pickModelId = (profiles: ModelProfile[], preferredModelId?: string): string => {
  if (preferredModelId && profiles.some((profile) => profile.modelId === preferredModelId)) {
    return preferredModelId;
  }

  const defaultProfile = profiles.find((profile) => profile.isDefault);
  if (defaultProfile) {
    return defaultProfile.modelId;
  }

  return profiles[0]?.modelId ?? preferredModelId ?? DEFAULT_MODEL_ID;
};

const loadModelsForProvider = async (providerId: string | null): Promise<ModelProfile[]> => {
  if (!providerId) {
    return [];
  }

  const models = await api.provider.listModels({ providerId });
  if (models.length > 0) {
    return models;
  }

  try {
    return await api.provider.refreshModels({ providerId });
  } catch {
    return [];
  }
};

const ensureStreamListener = (
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState
): void => {
  if (streamUnsubscribe) {
    return;
  }

  streamUnsubscribe = api.message.onStreamEvent((event: MessageStreamEvent) => {
    const state = get();
    if (!state.streaming.streamId || state.streaming.streamId !== event.streamId) {
      return;
    }

    if (event.type === 'status') {
      set((current) => ({
        streaming: {
          ...current.streaming,
          status: event.text ?? current.streaming.status
        }
      }));
      return;
    }

    if (event.type === 'trace' && event.trace) {
      const trace = event.trace;
      set((current) => ({
        streaming: {
          ...current.streaming,
          traces: [...current.streaming.traces, trace]
        }
      }));
      return;
    }

    if (event.type === 'text_delta' && event.text) {
      set((current) => ({
        streaming: {
          ...current.streaming,
          text: `${current.streaming.text}${event.text}`
        }
      }));
      return;
    }

    if (event.type === 'error') {
      set((current) => ({
        streaming: {
          ...current.streaming,
          active: false,
          status: event.text ?? 'Provider error'
        }
      }));
      return;
    }

    if (event.type === 'done') {
      set((current) => ({
        streaming: {
          ...current.streaming,
          active: false,
          status: current.streaming.status ?? 'Done'
        }
      }));
    }
  });
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const useChatStore = create<ChatState>((set, get) => ({
  ready: false,
  loading: false,
  providers: [],
  sessions: [],
  workspaces: [],
  modelProfiles: [],
  messages: [],
  selectedSessionId: null,
  selectedWorkspaceId: null,
  selectedModelId: DEFAULT_MODEL_ID,
  accessMode: 'scoped',
  usageSummary: null,
  streaming: {
    active: false,
    streamId: null,
    text: '',
    traces: [],
    status: null
  },

  initialize: async () => {
    set({ loading: true });
    ensureStreamListener(set, get);

    const [providers, sessions, workspaces, usageSummary, defaultModel, defaultWorkspace] = await Promise.all([
      api.provider.list(),
      api.session.list(),
      api.workspace.list(),
      api.usage.summary({ days: 30 }),
      api.settings.get({ key: 'default_model_id' }),
      api.settings.get({ key: 'default_workspace_id' })
    ]);

    let nextProviders = providers;
    if (providers.length === 0) {
      const provider = await api.provider.create({
        type: 'openai',
        displayName: 'OpenAI Primary',
        authKind: 'api_key'
      });
      nextProviders = [provider];
    }

    const selectedSessionId = sessions[0]?.id ?? null;
    const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
    const messages = selectedSessionId ? await api.message.list({ sessionId: selectedSessionId }) : [];
    const activeProviderId = selectedSession?.providerId ?? nextProviders[0]?.id ?? null;
    const modelProfiles = await loadModelsForProvider(activeProviderId);

    const selectedWorkspaceId =
      selectedSession?.workspaceId ??
      (typeof defaultWorkspace === 'string' && defaultWorkspace ? defaultWorkspace : workspaces[0]?.id ?? null);

    set({
      ready: true,
      loading: false,
      providers: nextProviders,
      sessions,
      workspaces,
      modelProfiles,
      selectedSessionId,
      selectedWorkspaceId,
      messages,
      usageSummary,
      selectedModelId: pickModelId(modelProfiles, typeof defaultModel === 'string' ? defaultModel : undefined)
    });
  },

  createProvider: async (input) => {
    const provider = await api.provider.create({
      type: input.type ?? 'openai',
      displayName: input.displayName,
      authKind: input.authKind
    });

    set((state) => ({ providers: [provider, ...state.providers] }));
  },

  createSession: async (title: string) => {
    const providerId = pickProviderId(get().providers);
    if (!providerId) {
      return;
    }

    const workspaceId = get().selectedWorkspaceId ?? undefined;
    const session = await api.session.create({ title, providerId, workspaceId });
    const modelProfiles = await loadModelsForProvider(session.providerId);
    set((state) => ({
      sessions: [session, ...state.sessions],
      selectedSessionId: session.id,
      messages: [],
      selectedWorkspaceId: session.workspaceId ?? state.selectedWorkspaceId,
      modelProfiles,
      selectedModelId: pickModelId(modelProfiles, state.selectedModelId)
    }));
  },

  selectSession: async (sessionId: string) => {
    const messages = await api.message.list({ sessionId });
    const session = get().sessions.find((value) => value.id === sessionId) ?? null;
    const modelProfiles = await loadModelsForProvider(session?.providerId ?? null);

    set({
      selectedSessionId: sessionId,
      messages,
      selectedWorkspaceId: session?.workspaceId ?? get().selectedWorkspaceId,
      modelProfiles,
      selectedModelId: pickModelId(modelProfiles, get().selectedModelId)
    });
  },

  sendMessage: async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    const runningStreamId = get().streaming.active ? get().streaming.streamId : null;
    if (runningStreamId) {
      await get().cancelMessage();

      const started = Date.now();
      while (true) {
        const { streaming } = get();
        const settled = !streaming.active || streaming.streamId !== runningStreamId;
        if (settled) {
          break;
        }

        if (Date.now() - started >= CANCEL_WAIT_TIMEOUT_MS) {
          break;
        }
        await wait(40);
      }
    }

    const sessionId = get().selectedSessionId;
    if (!sessionId) {
      await get().createSession('New Vibe Session');
    }

    const activeSessionId = get().selectedSessionId;
    if (!activeSessionId) {
      return;
    }

    const streamId = `stream_${nanoid(10)}`;
    set({
      streaming: {
        active: true,
        streamId,
        text: '',
        traces: [],
        status: 'Starting...'
      }
    });

    const sent = await api.message.send({
      sessionId: activeSessionId,
      content: trimmed,
      streamId,
      modelId: get().selectedModelId,
      accessMode: get().accessMode,
      workspaceId: get().selectedWorkspaceId ?? undefined
    });

    set((state) => ({
      messages: [...state.messages, sent.userMessage, sent.assistantMessage],
      streaming:
        state.streaming.streamId === streamId
          ? {
              ...state.streaming,
              active: false,
              status: state.streaming.status ?? 'Done'
            }
          : state.streaming
    }));

    const usageSummary = await api.usage.summary({ days: 30 });
    set({ usageSummary });
  },

  cancelMessage: async () => {
    const streamId = get().streaming.streamId;
    if (!streamId) {
      return;
    }

    set((state) => ({
      streaming: {
        ...state.streaming,
        status: 'Cancelling...'
      }
    }));

    await api.message.cancel({ streamId });
  },

  saveProviderSecret: async (providerId, secret) => {
    return api.provider.saveSecret({ providerId, secret });
  },

  testProvider: async (providerId) => {
    const result = await api.provider.testConnection({ providerId });

    if (result.ok) {
      const models = result.models ?? (await api.provider.listModels({ providerId }));
      const state = get();
      if (getActiveProviderId(state) === providerId) {
        set({
          modelProfiles: models,
          selectedModelId: pickModelId(models, state.selectedModelId)
        });
      }
    }

    return result;
  },

  addWorkspace: async (workspacePath) => {
    const workspace = await api.workspace.add({ path: workspacePath, trustLevel: 'trusted' });
    set((state) => ({
      workspaces: [workspace, ...state.workspaces],
      selectedWorkspaceId: workspace.id
    }));

    await api.settings.set({ key: 'default_workspace_id', value: workspace.id });
  },

  setSelectedWorkspaceId: async (workspaceId) => {
    set({ selectedWorkspaceId: workspaceId });
    if (workspaceId) {
      await api.settings.set({ key: 'default_workspace_id', value: workspaceId });
    }
  },

  setSelectedModelId: async (modelId) => {
    const nextModelId = modelId.trim() || DEFAULT_MODEL_ID;
    set({ selectedModelId: nextModelId });
    await api.settings.set({ key: 'default_model_id', value: nextModelId });
  },

  setAccessMode: (mode) => {
    set({ accessMode: mode });
  },

  openExternal: async (url) => {
    await api.system.openExternal({ url });
  },

  startSubscriptionLogin: async (providerId) => {
    return api.provider.startSubscriptionLogin({ providerId });
  },

  getSubscriptionLoginState: async () => {
    return api.provider.getSubscriptionLoginState();
  }
}));
