export type Provider = {
  id: string;
  type: 'openai' | 'anthropic' | 'local';
  displayName: string;
  authKind: 'api_key' | 'oauth_subscription';
  keychainRef: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
};

export type ProviderSubscriptionLoginState = {
  status: 'idle' | 'pending' | 'success' | 'error';
  verificationUri?: string;
  userCode?: string;
  message?: string;
  startedAt?: number;
  updatedAt: number;
};

export type MessageAccessMode = 'scoped' | 'root';

export type MessageStreamTrace = {
  traceKind: 'thought' | 'plan' | 'action';
  text: string;
};

export type MessageStreamEvent = {
  streamId: string;
  sessionId: string;
  type: 'status' | 'trace' | 'text_delta' | 'error' | 'done';
  text?: string;
  trace?: MessageStreamTrace;
};

export type Session = {
  id: string;
  workspaceId: string | null;
  title: string;
  providerId: string;
  modelProfileId: string | null;
  status: 'active' | 'archived' | 'error';
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
};

export type Message = {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  contentFormat: string;
  toolName: string | null;
  toolCallId: string | null;
  seq: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicrounits: number | null;
  createdAt: number;
};

export type Workspace = {
  id: string;
  name: string;
  rootPath: string;
  trustLevel: 'trusted' | 'read_only' | 'untrusted';
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
};

export type ModelProfile = {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  isDefault: boolean;
  updatedAt: number;
};

export type OpenVibezApi = {
  provider: {
    list: () => Promise<Provider[]>;
    create: (input: { type: Provider['type']; displayName: string; authKind: Provider['authKind'] }) => Promise<Provider>;
    saveSecret: (input: { providerId: string; secret: string }) => Promise<{ ok: boolean }>;
    testConnection: (input: {
      providerId: string;
    }) => Promise<{ ok: boolean; status?: number; reason?: string; models?: ModelProfile[] }>;
    startSubscriptionLogin: (input: { providerId: string }) => Promise<ProviderSubscriptionLoginState>;
    getSubscriptionLoginState: () => Promise<ProviderSubscriptionLoginState>;
    listModels: (input: { providerId: string }) => Promise<ModelProfile[]>;
    refreshModels: (input: { providerId: string }) => Promise<ModelProfile[]>;
  };
  session: {
    create: (input: { title: string; providerId: string; workspaceId?: string; modelProfileId?: string }) => Promise<Session>;
    list: () => Promise<Session[]>;
    archive: (input: { sessionId: string }) => Promise<{ ok: boolean }>;
  };
  message: {
    send: (input: {
      sessionId: string;
      content: string;
      streamId?: string;
      modelId?: string;
      accessMode?: MessageAccessMode;
      workspaceId?: string;
    }) => Promise<{ userMessage: Message; assistantMessage: Message }>;
    cancel: (input: { streamId: string }) => Promise<{ ok: boolean }>;
    list: (input: { sessionId: string }) => Promise<Message[]>;
    onStreamEvent: (handler: (event: MessageStreamEvent) => void) => () => void;
  };
  workspace: {
    add: (input: { path: string; trustLevel?: Workspace['trustLevel'] }) => Promise<Workspace>;
    list: () => Promise<Workspace[]>;
  };
  settings: {
    get: (input: { key: string }) => Promise<unknown | null>;
    set: (input: { key: string; value: unknown }) => Promise<{ ok: boolean }>;
  };
  usage: {
    summary: (input: { days: number }) => Promise<{ inputTokens: number; outputTokens: number; costMicrounits: number }>;
  };
  system: {
    openExternal: (input: { url: string }) => Promise<{ ok: boolean }>;
  };
};

declare global {
  interface Window {
    openvibez: OpenVibezApi;
  }
}
