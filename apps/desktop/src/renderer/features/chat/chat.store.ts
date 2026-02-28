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

export type StreamTimelineEntry =
  | { type: 'run_marker'; runId: string }
  | { type: 'trace'; trace: MessageStreamTrace }
  | { type: 'text'; content: string };

type StreamingState = {
  active: boolean;
  streamId: string | null;
  sessionId: string | null;
  text: string;
  traces: MessageStreamTrace[];
  timeline: StreamTimelineEntry[];
  status: string | null;
  statusTrail: string[];
};

type ChatState = {
  ready: boolean;
  loading: boolean;
  providers: Provider[];
  sessions: Session[];
  workspaces: Workspace[];
  modelProfiles: ModelProfile[];
  providerModelsById: Record<string, ModelProfile[]>;
  messages: Message[];
  selectedSessionId: string | null;
  selectedProviderId: string | null;
  selectedWorkspaceId: string | null;
  selectedModelId: string;
  accessMode: MessageAccessMode;
  usageSummary: { inputTokens: number; outputTokens: number; costMicrounits: number } | null;
  sessionTracesById: Record<string, MessageStreamTrace[]>;
  sessionStatusesById: Record<string, string[]>;
  sessionTimelineById: Record<string, StreamTimelineEntry[]>;
  streaming: StreamingState;
  initialize: () => Promise<void>;
  createProvider: (input: { displayName: string; authKind: Provider['authKind']; type?: Provider['type'] }) => Promise<Provider>;
  createSession: (title: string) => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelMessage: () => Promise<void>;
  setSelectedProviderId: (providerId: string) => Promise<void>;
  saveProviderSecret: (providerId: string, secret: string) => Promise<{ ok: boolean }>;
  testProvider: (providerId: string) => Promise<{ ok: boolean; status?: number; reason?: string; models?: ModelProfile[] }>;
  addWorkspace: (path: string) => Promise<void>;
  setSelectedWorkspaceId: (workspaceId: string | null) => Promise<void>;
  setSelectedModelId: (modelId: string) => Promise<void>;
  selectChatModel: (input: { providerId: string; modelId: string }) => Promise<void>;
  setAccessMode: (mode: MessageAccessMode) => void;
  openExternal: (url: string) => Promise<void>;
  startSubscriptionLogin: (providerId: string) => Promise<ProviderSubscriptionLoginState>;
  getSubscriptionLoginState: () => Promise<ProviderSubscriptionLoginState>;
};

const DEFAULT_MODEL_ID = 'gpt-4o-mini';
const CANCEL_WAIT_TIMEOUT_MS = 4000;
const sessionTimelineKey = (sessionId: string): string => `session_timeline:${sessionId}`;

let streamUnsubscribe: (() => void) | null = null;

const pickProviderId = (providers: Provider[], preferred?: string | null): string | null => {
  if (preferred && providers.some((provider) => provider.id === preferred)) {
    return preferred;
  }

  return providers[0]?.id ?? null;
};

const getActiveProviderId = (
  state: Pick<ChatState, 'selectedProviderId' | 'sessions' | 'selectedSessionId' | 'providers'>
): string | null => {
  if (state.selectedProviderId && state.providers.some((provider) => provider.id === state.selectedProviderId)) {
    return state.selectedProviderId;
  }

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

const pickModelProfileId = (profiles: ModelProfile[], modelId: string): string | undefined => {
  return profiles.find((profile) => profile.modelId === modelId)?.id;
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

const loadModelsForProviders = async (
  providers: Provider[]
): Promise<Record<string, ModelProfile[]>> => {
  const entries = await Promise.all(
    providers.map(async (provider) => [provider.id, await loadModelsForProvider(provider.id)] as const)
  );

  return Object.fromEntries(entries);
};

const withProviderModels = (
  current: Record<string, ModelProfile[]>,
  providerId: string,
  models: ModelProfile[]
): Record<string, ModelProfile[]> => ({
  ...current,
  [providerId]: models
});

const appendStatus = (statuses: string[], nextStatus: string | null | undefined): string[] => {
  const normalized = nextStatus?.trim();
  if (!normalized) {
    return statuses;
  }

  if (statuses[statuses.length - 1] === normalized) {
    return statuses;
  }

  return [...statuses, normalized];
};

const isActionKind = (value: unknown): value is MessageStreamTrace['actionKind'] => {
  return (
    value === 'file-edit' ||
    value === 'file-read' ||
    value === 'file-create' ||
    value === 'file-delete' ||
    value === 'search' ||
    value === 'command' ||
    value === 'command-result' ||
    value === 'generic'
  );
};

const PROTOCOL_NOISE_PATTERNS: RegExp[] = [
  /^model\s+turn\s+\d+\s*:/i,
  /(?:^|\s)(PLAN|TOOL_CALL|STEP_DONE|FINAL)\s*\{/i,
  /^invalid protocol/i
];

const isProtocolNoiseText = (value: string): boolean => {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return PROTOCOL_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
};

const sanitizeTimelineText = (value: string): string => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !isProtocolNoiseText(line));
  return lines.join('\n').trim();
};

const asTimelineEntry = (value: unknown): StreamTimelineEntry | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as { type?: unknown; runId?: unknown; trace?: unknown; content?: unknown };
  if (item.type === 'run_marker' && typeof item.runId === 'string' && item.runId.trim()) {
    return { type: 'run_marker', runId: item.runId.trim() };
  }

  if (item.type === 'text' && typeof item.content === 'string') {
    const content = sanitizeTimelineText(item.content);
    if (!content) {
      return null;
    }
    return { type: 'text', content };
  }

  if (item.type === 'trace' && item.trace && typeof item.trace === 'object') {
    const trace = item.trace as { traceKind?: unknown; text?: unknown; actionKind?: unknown };
    if (
      (trace.traceKind === 'thought' || trace.traceKind === 'plan' || trace.traceKind === 'action') &&
      typeof trace.text === 'string'
    ) {
      const sanitizedText = sanitizeTimelineText(trace.text);
      if (!sanitizedText) {
        return null;
      }

      return {
        type: 'trace',
        trace: {
          traceKind: trace.traceKind,
          text: sanitizedText,
          actionKind: isActionKind(trace.actionKind) ? trace.actionKind : undefined
        }
      };
    }
  }

  return null;
};

const normalizeTimeline = (value: unknown): StreamTimelineEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asTimelineEntry(entry))
    .filter((entry): entry is StreamTimelineEntry => Boolean(entry));
};

const tracesFromTimeline = (timeline: StreamTimelineEntry[]): MessageStreamTrace[] => {
  return timeline
    .filter((entry): entry is Extract<StreamTimelineEntry, { type: 'trace' }> => entry.type === 'trace')
    .map((entry) => entry.trace);
};

const loadSessionTimeline = async (sessionId: string | null): Promise<StreamTimelineEntry[]> => {
  if (!sessionId) {
    return [];
  }

  const stored = await api.settings.get({ key: sessionTimelineKey(sessionId) });
  return normalizeTimeline(stored);
};

const persistSessionTimeline = async (sessionId: string, timeline: StreamTimelineEntry[]): Promise<void> => {
  await api.settings.set({ key: sessionTimelineKey(sessionId), value: timeline });
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
    if (
      !state.streaming.streamId ||
      state.streaming.streamId !== event.streamId ||
      state.streaming.sessionId !== event.sessionId
    ) {
      return;
    }

    if (event.type === 'status') {
      set((current) => {
        const sessionStatuses = current.sessionStatusesById[event.sessionId] ?? [];
        const nextStatuses = appendStatus(sessionStatuses, event.text ?? current.streaming.status);
        return {
          sessionStatusesById: {
            ...current.sessionStatusesById,
            [event.sessionId]: nextStatuses
          },
          streaming: {
            ...current.streaming,
            status: event.text ?? current.streaming.status,
            statusTrail: nextStatuses
          }
        };
      });
      return;
    }

    if (event.type === 'trace' && event.trace) {
      const traceText = sanitizeTimelineText(event.trace.text);
      if (!traceText) {
        return;
      }

      const trace: MessageStreamTrace = {
        ...event.trace,
        text: traceText
      };
      set((current) => {
        const nextTimeline = [...current.streaming.timeline, { type: 'trace', trace } as StreamTimelineEntry];
        return {
          sessionTracesById: {
            ...current.sessionTracesById,
            [event.sessionId]: [...(current.sessionTracesById[event.sessionId] ?? []), trace]
          },
          sessionTimelineById: {
            ...current.sessionTimelineById,
            [event.sessionId]: nextTimeline
          },
          streaming: {
            ...current.streaming,
            traces: [...(current.sessionTracesById[event.sessionId] ?? []), trace],
            timeline: nextTimeline
          }
        };
      });
      return;
    }

    if (event.type === 'text_delta' && event.text) {
      const delta = event.text;
      set((current) => {
        const timeline = [...current.streaming.timeline];
        const last = timeline[timeline.length - 1];
        if (last && last.type === 'text') {
          timeline[timeline.length - 1] = { type: 'text', content: last.content + delta };
        } else {
          timeline.push({ type: 'text', content: delta });
        }
        return {
          sessionTimelineById: {
            ...current.sessionTimelineById,
            [event.sessionId]: timeline
          },
          streaming: {
            ...current.streaming,
            text: `${current.streaming.text}${delta}`,
            timeline
          }
        };
      });
      return;
    }

    if (event.type === 'error') {
      set((current) => {
        const nextStatus = event.text ?? 'Provider error';
        const sessionStatuses = current.sessionStatusesById[event.sessionId] ?? [];
        const nextStatuses = appendStatus(sessionStatuses, nextStatus);
        return {
          sessionStatusesById: {
            ...current.sessionStatusesById,
            [event.sessionId]: nextStatuses
          },
          streaming: {
            ...current.streaming,
            active: false,
            status: nextStatus,
            statusTrail: nextStatuses
          }
        };
      });
      return;
    }

    if (event.type === 'done') {
      set((current) => {
        const nextStatus = current.streaming.status ?? 'Done';
        const sessionStatuses = current.sessionStatusesById[event.sessionId] ?? [];
        const nextStatuses = appendStatus(sessionStatuses, nextStatus);
        return {
          sessionStatusesById: {
            ...current.sessionStatusesById,
            [event.sessionId]: nextStatuses
          },
          streaming: {
            ...current.streaming,
            active: false,
            status: nextStatus,
            statusTrail: nextStatuses
          }
        };
      });
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
  providerModelsById: {},
  messages: [],
  selectedSessionId: null,
  selectedProviderId: null,
  selectedWorkspaceId: null,
  selectedModelId: DEFAULT_MODEL_ID,
  accessMode: 'scoped',
  usageSummary: null,
  sessionTracesById: {},
  sessionStatusesById: {},
  sessionTimelineById: {},
  streaming: {
    active: false,
    streamId: null,
    sessionId: null,
    text: '',
    traces: [],
    timeline: [],
    status: null,
    statusTrail: []
  },

  initialize: async () => {
    set({ loading: true });
    ensureStreamListener(set, get);

    const [providers, sessions, workspaces, usageSummary, defaultModel, defaultWorkspace, defaultProvider] = await Promise.all([
      api.provider.list(),
      api.session.list(),
      api.workspace.list(),
      api.usage.summary({ days: 30 }),
      api.settings.get({ key: 'default_model_id' }),
      api.settings.get({ key: 'default_workspace_id' }),
      api.settings.get({ key: 'default_provider_id' })
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
    const selectedTimeline = await loadSessionTimeline(selectedSessionId);
    const providerFromSettings =
      typeof defaultProvider === 'string' && defaultProvider.trim() ? defaultProvider.trim() : null;
    const selectedProviderId = pickProviderId(nextProviders, selectedSession?.providerId ?? providerFromSettings);
    const providerModelsById = await loadModelsForProviders(nextProviders);
    const modelProfiles = selectedProviderId ? (providerModelsById[selectedProviderId] ?? []) : [];

    const selectedWorkspaceId = selectedSession
      ? selectedSession.workspaceId
      : (typeof defaultWorkspace === 'string' && defaultWorkspace ? defaultWorkspace : workspaces[0]?.id ?? null);

    set({
      ready: true,
      loading: false,
      providers: nextProviders,
      sessions,
      workspaces,
      modelProfiles,
      providerModelsById,
      selectedSessionId,
      selectedProviderId,
      selectedWorkspaceId,
      messages,
      usageSummary,
      sessionTimelineById: selectedSessionId ? { [selectedSessionId]: selectedTimeline } : {},
      sessionTracesById: selectedSessionId ? { [selectedSessionId]: tracesFromTimeline(selectedTimeline) } : {},
      selectedModelId: pickModelId(modelProfiles, typeof defaultModel === 'string' ? defaultModel : undefined)
    });
  },

  createProvider: async (input) => {
    const provider = await api.provider.create({
      type: input.type ?? 'openai',
      displayName: input.displayName,
      authKind: input.authKind
    });

    const hadSelectedProvider = Boolean(get().selectedProviderId);
    set((state) => {
      const selectedProviderId = state.selectedProviderId ?? provider.id;
      return { providers: [provider, ...state.providers], selectedProviderId };
    });

    if (!hadSelectedProvider) {
      await api.settings.set({ key: 'default_provider_id', value: provider.id });
      const modelProfiles = await loadModelsForProvider(provider.id);
      set((state) => ({
        selectedProviderId: provider.id,
        modelProfiles,
        providerModelsById: withProviderModels(state.providerModelsById, provider.id, modelProfiles),
        selectedModelId: pickModelId(modelProfiles, state.selectedModelId)
      }));
    }

    return provider;
  },

  createSession: async (title: string) => {
    const state = get();
    const providerId = pickProviderId(state.providers, state.selectedProviderId);
    if (!providerId) {
      return;
    }

    const workspaceId = state.selectedWorkspaceId ?? undefined;
    const modelProfileId = pickModelProfileId(state.modelProfiles, state.selectedModelId);
    const session = await api.session.create({ title, providerId, workspaceId, modelProfileId });
    const modelProfiles = await loadModelsForProvider(session.providerId);
    set((state) => ({
      sessions: [session, ...state.sessions],
      selectedSessionId: session.id,
      selectedProviderId: session.providerId,
      messages: [],
      selectedWorkspaceId: session.workspaceId,
      modelProfiles,
      providerModelsById: withProviderModels(state.providerModelsById, session.providerId, modelProfiles),
      selectedModelId: pickModelId(modelProfiles, state.selectedModelId)
    }));

    await api.settings.set({ key: 'default_provider_id', value: session.providerId });
  },

  selectSession: async (sessionId: string) => {
    const [messages, timeline] = await Promise.all([api.message.list({ sessionId }), loadSessionTimeline(sessionId)]);
    const session = get().sessions.find((value) => value.id === sessionId) ?? null;
    const modelProfiles = await loadModelsForProvider(session?.providerId ?? null);

    set({
      selectedSessionId: sessionId,
      selectedProviderId: session?.providerId ?? get().selectedProviderId,
      messages,
      selectedWorkspaceId: session ? session.workspaceId : get().selectedWorkspaceId,
      sessionTimelineById: {
        ...get().sessionTimelineById,
        [sessionId]: timeline
      },
      sessionTracesById: {
        ...get().sessionTracesById,
        [sessionId]: tracesFromTimeline(timeline)
      },
      modelProfiles,
      providerModelsById: session?.providerId
        ? withProviderModels(get().providerModelsById, session.providerId, modelProfiles)
        : get().providerModelsById,
      selectedModelId: pickModelId(modelProfiles, get().selectedModelId)
    });

    if (session?.providerId) {
      await api.settings.set({ key: 'default_provider_id', value: session.providerId });
    }
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
      await get().createSession('New Session');
    }

    const activeSessionId = get().selectedSessionId;
    if (!activeSessionId) {
      return;
    }

    const streamId = `stream_${nanoid(10)}`;
    const clientRequestId = `req_${nanoid(12)}`;
    const runMarker: StreamTimelineEntry = { type: 'run_marker', runId: clientRequestId };
    const optimisticUserMessageId = `tmp_user_${clientRequestId}`;
    const optimisticUserMessage: Message = {
      id: optimisticUserMessageId,
      sessionId: activeSessionId,
      role: 'user',
      content: trimmed,
      contentFormat: 'markdown',
      toolName: null,
      toolCallId: null,
      seq: -1,
      inputTokens: null,
      outputTokens: null,
      costMicrounits: null,
      createdAt: Date.now()
    };

    set((state) => ({
      sessionTimelineById: {
        ...state.sessionTimelineById,
        [activeSessionId]: [...(state.sessionTimelineById[activeSessionId] ?? []), runMarker]
      },
      messages:
        state.selectedSessionId === activeSessionId
          ? [...state.messages, optimisticUserMessage]
          : state.messages,
      sessionTracesById: state.sessionTracesById,
      sessionStatusesById: {
        ...state.sessionStatusesById,
        [activeSessionId]: ['Starting...']
      },
      streaming: {
        active: true,
        streamId,
        sessionId: activeSessionId,
        text: '',
        traces: state.sessionTracesById[activeSessionId] ?? [],
        timeline: [...(state.sessionTimelineById[activeSessionId] ?? []), runMarker],
        status: 'Starting...',
        statusTrail: ['Starting...']
      }
    }));

    try {
      const sent = await api.message.send({
        sessionId: activeSessionId,
        content: trimmed,
        streamId,
        clientRequestId,
        modelId: get().selectedModelId,
        accessMode: get().accessMode,
        workspaceId: get().selectedWorkspaceId ?? undefined
      });

      const updatedSession = sent.session;

      set((state) => {
        const sessions = updatedSession
          ? [updatedSession, ...state.sessions.filter((session) => session.id !== updatedSession.id)]
          : state.sessions;
        const keepCurrentMessages = state.selectedSessionId !== activeSessionId;
        const withoutOptimistic = state.messages.filter((message) => message.id !== optimisticUserMessageId);

        return {
          messages: keepCurrentMessages ? state.messages : [...withoutOptimistic, sent.userMessage, sent.assistantMessage],
          sessions,
          streaming:
            state.streaming.streamId === streamId
              ? {
                  ...state.streaming,
                  active: false,
                  status: state.streaming.status ?? 'Done'
                }
              : state.streaming
        };
      });

      const usageSummary = await api.usage.summary({ days: 30 });
      set({ usageSummary });
      void persistSessionTimeline(activeSessionId, get().sessionTimelineById[activeSessionId] ?? []);
    } catch (error) {
      set((state) => ({
        messages:
          state.selectedSessionId === activeSessionId
            ? state.messages.filter((message) => message.id !== optimisticUserMessageId)
            : state.messages,
        streaming:
          state.streaming.streamId === streamId
            ? {
                ...state.streaming,
                active: false,
                status: 'Error',
                statusTrail: appendStatus(state.streaming.statusTrail, 'Error')
              }
            : state.streaming
      }));
      void persistSessionTimeline(activeSessionId, get().sessionTimelineById[activeSessionId] ?? []);
      throw error;
    }
  },

  cancelMessage: async () => {
    const streamId = get().streaming.streamId;
    if (!streamId) {
      return;
    }

    set((state) => ({
      sessionStatusesById: state.streaming.sessionId
        ? {
            ...state.sessionStatusesById,
            [state.streaming.sessionId]: appendStatus(
              state.sessionStatusesById[state.streaming.sessionId] ?? [],
              'Cancelling...'
            )
          }
        : state.sessionStatusesById,
      streaming: {
        ...state.streaming,
        status: 'Cancelling...',
        statusTrail: appendStatus(state.streaming.statusTrail, 'Cancelling...')
      }
    }));

    await api.message.cancel({ streamId });
  },

  setSelectedProviderId: async (providerId) => {
    const nextProviderId = providerId.trim();
    if (!nextProviderId) {
      return;
    }

    const state = get();
    if (!state.providers.some((provider) => provider.id === nextProviderId)) {
      return;
    }

    set({ selectedProviderId: nextProviderId });
    await api.settings.set({ key: 'default_provider_id', value: nextProviderId });

    let updatedSession: Session | null = null;
    if (state.selectedSessionId) {
      updatedSession = await api.session.setProvider({
        sessionId: state.selectedSessionId,
        providerId: nextProviderId
      });
    }

    const modelProfiles = await loadModelsForProvider(nextProviderId);
    set((current) => ({
      selectedProviderId: nextProviderId,
      sessions: updatedSession
        ? current.sessions.map((session) => (session.id === updatedSession.id ? updatedSession : session))
        : current.sessions,
      selectedWorkspaceId: updatedSession ? updatedSession.workspaceId : current.selectedWorkspaceId,
      modelProfiles,
      providerModelsById: withProviderModels(current.providerModelsById, nextProviderId, modelProfiles),
      selectedModelId: pickModelId(modelProfiles, current.selectedModelId)
    }));
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
          providerModelsById: withProviderModels(state.providerModelsById, providerId, models),
          selectedModelId: pickModelId(models, state.selectedModelId)
        });
      } else {
        set({
          providerModelsById: withProviderModels(state.providerModelsById, providerId, models)
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
    const state = get();
    const selectedSession = state.sessions.find((session) => session.id === state.selectedSessionId) ?? null;
    const selectedSessionMatchesWorkspace = selectedSession?.workspaceId === workspaceId;

    if (selectedSessionMatchesWorkspace) {
      set({ selectedWorkspaceId: workspaceId });
    } else {
      const nextSession = state.sessions.find((session) => session.workspaceId === workspaceId) ?? null;
      const messages = nextSession ? await api.message.list({ sessionId: nextSession.id }) : [];
      const nextProviderId = nextSession?.providerId ?? pickProviderId(state.providers, state.selectedProviderId);
      const modelProfiles = await loadModelsForProvider(nextProviderId);

      set({
        selectedWorkspaceId: workspaceId,
        selectedSessionId: nextSession?.id ?? null,
        selectedProviderId: nextSession?.providerId ?? nextProviderId,
        messages,
        modelProfiles,
        providerModelsById: nextProviderId
          ? withProviderModels(state.providerModelsById, nextProviderId, modelProfiles)
          : state.providerModelsById,
        selectedModelId: pickModelId(modelProfiles, state.selectedModelId)
      });

      if (nextSession?.providerId) {
        await api.settings.set({ key: 'default_provider_id', value: nextSession.providerId });
      }
    }

    await api.settings.set({ key: 'default_workspace_id', value: workspaceId });
  },

  setSelectedModelId: async (modelId) => {
    const nextModelId = modelId.trim() || DEFAULT_MODEL_ID;
    set({ selectedModelId: nextModelId });
    await api.settings.set({ key: 'default_model_id', value: nextModelId });
  },

  selectChatModel: async ({ providerId, modelId }) => {
    const nextProviderId = providerId.trim();
    const nextModelId = modelId.trim() || DEFAULT_MODEL_ID;
    if (!nextProviderId) {
      return;
    }

    const state = get();
    if (!state.providers.some((provider) => provider.id === nextProviderId)) {
      return;
    }

    let updatedSession: Session | null = null;
    if (state.selectedSessionId) {
      const selectedSession = state.sessions.find((session) => session.id === state.selectedSessionId) ?? null;
      if (selectedSession && selectedSession.providerId !== nextProviderId) {
        updatedSession = await api.session.setProvider({
          sessionId: state.selectedSessionId,
          providerId: nextProviderId
        });
      }
    }

    const modelProfiles =
      state.providerModelsById[nextProviderId] ?? (await loadModelsForProvider(nextProviderId));

    set((current) => ({
      selectedProviderId: nextProviderId,
      selectedModelId: nextModelId,
      modelProfiles,
      providerModelsById: withProviderModels(current.providerModelsById, nextProviderId, modelProfiles),
      sessions: updatedSession
        ? current.sessions.map((session) => (session.id === updatedSession.id ? updatedSession : session))
        : current.sessions,
      selectedWorkspaceId: updatedSession ? updatedSession.workspaceId : current.selectedWorkspaceId
    }));

    await Promise.all([
      api.settings.set({ key: 'default_provider_id', value: nextProviderId }),
      api.settings.set({ key: 'default_model_id', value: nextModelId })
    ]);
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
