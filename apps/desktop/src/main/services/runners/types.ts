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
    backgroundModeEnabled?: boolean;
    backgroundPollIntervalMs?: number;
  };
  codexOptions?: {
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    outputSchemaJson?: string;
    sdkPilotEnabled?: boolean;
  };
  signal: AbortSignal;
  onEvent?: (event: RunnerEvent) => void;
};

export type ProviderRunner = (input: RunnerContext) => Promise<RunnerResult>;
