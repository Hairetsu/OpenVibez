import type { ProviderRow, WorkspaceRow } from '../db';

export type RunnerHistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export type RunnerTrace = {
  traceKind: 'thought' | 'plan' | 'action';
  text: string;
  actionKind?: string;
};

export type RunnerEvent =
  | { type: 'status'; text: string }
  | { type: 'trace'; trace: RunnerTrace }
  | { type: 'assistant_delta'; delta: string };

export type RunnerResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
};

export type RunnerContext = {
  provider: ProviderRow;
  secret: string | null;
  modelProfileId: string | null;
  requestedModelId?: string;
  requestMeta?: {
    runId: string;
    sessionId: string;
    clientRequestId: string;
  };
  history: RunnerHistoryMessage[];
  accessMode: 'scoped' | 'root';
  workspace?: WorkspaceRow;
  openaiOptions?: {
    baseUrl?: string;
    backgroundModeEnabled?: boolean;
    backgroundPollIntervalMs?: number;
  };
  codexOptions?: {
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    outputSchemaJson?: string;
    sdkPilotEnabled?: boolean;
  };
  openrouterOptions?: {
    appOrigin?: string;
    appTitle?: string;
    pricingByModel?: Record<string, { promptPerToken: number; completionPerToken: number }>;
  };
  localOptions?: {
    temperature?: number;
    maxOutputTokens?: number;
    numCtx?: number;
  };
  signal: AbortSignal;
  onEvent?: (event: RunnerEvent) => void;
};

export type ProviderRunner = (input: RunnerContext) => Promise<RunnerResult>;
