import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { makeId } from '../util/ids';

export type ProviderRow = {
  id: string;
  type: 'openai' | 'anthropic' | 'local';
  display_name: string;
  auth_kind: 'api_key' | 'oauth_subscription';
  keychain_ref: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  root_path: string;
  trust_level: 'trusted' | 'read_only' | 'untrusted';
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
};

export type SessionRow = {
  id: string;
  workspace_id: string | null;
  title: string;
  provider_id: string;
  model_profile_id: string | null;
  status: 'active' | 'archived' | 'error';
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
};

export type ModelProfileRow = {
  id: string;
  provider_id: string;
  model_id: string;
  label: string;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
  is_default: number;
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  session_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  content_format: string;
  tool_name: string | null;
  tool_call_id: string | null;
  seq: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microunits: number | null;
  created_at: number;
};

export type AssistantRunRow = {
  id: string;
  session_id: string;
  client_request_id: string;
  stream_id: string;
  status: 'running' | 'completed' | 'failed';
  user_message_id: string | null;
  assistant_message_id: string | null;
  error_text: string | null;
  created_at: number;
  updated_at: number;
};

let sqlite: Database.Database | null = null;

const now = (): number => Date.now();

const getDbPath = (): string => {
  const userDataDir = app.getPath('userData');
  return path.join(userDataDir, 'openvibez.db');
};

const migrate = (db: Database.Database): void => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      auth_kind TEXT NOT NULL,
      keychain_ref TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_providers_type ON providers(type);
    CREATE INDEX IF NOT EXISTS idx_providers_active ON providers(is_active);

    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      label TEXT NOT NULL,
      temperature REAL,
      top_p REAL,
      max_output_tokens INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE,
      UNIQUE(provider_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_profiles_provider ON model_profiles(provider_id);

    CREATE TABLE IF NOT EXISTS workspace_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      trust_level TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_profile_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_at INTEGER,
      FOREIGN KEY(workspace_id) REFERENCES workspace_projects(id) ON DELETE SET NULL,
      FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE RESTRICT,
      FOREIGN KEY(model_profile_id) REFERENCES model_profiles(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_message_at ON sessions(last_message_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      content_format TEXT NOT NULL DEFAULT 'markdown',
      tool_name TEXT,
      tool_call_id TEXT,
      seq INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_microunits INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      event_type TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_microunits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE RESTRICT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_provider_created ON usage_events(provider_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_session_created ON usage_events(session_id, created_at);

    CREATE TABLE IF NOT EXISTS assistant_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      status TEXT NOT NULL,
      user_message_id TEXT,
      assistant_message_id TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(user_message_id) REFERENCES messages(id) ON DELETE SET NULL,
      FOREIGN KEY(assistant_message_id) REFERENCES messages(id) ON DELETE SET NULL,
      UNIQUE(session_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_runs_session_created ON assistant_runs(session_id, created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_state_kind ON background_jobs(state, kind);
  `);
};

export const initDb = (): Database.Database => {
  if (sqlite) {
    return sqlite;
  }

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  migrate(sqlite);
  return sqlite;
};

export const getDb = (): Database.Database => {
  if (!sqlite) {
    return initDb();
  }
  return sqlite;
};

export const listProviders = (): ProviderRow[] => {
  return getDb().prepare('SELECT * FROM providers WHERE is_active = 1 ORDER BY updated_at DESC').all() as ProviderRow[];
};

export const createProvider = (input: {
  type: ProviderRow['type'];
  displayName: string;
  authKind: ProviderRow['auth_kind'];
}): ProviderRow => {
  const ts = now();
  const id = makeId('prov');
  const keychainRef = `${id}:${input.authKind}`;

  getDb()
    .prepare(
      `INSERT INTO providers (id, type, display_name, auth_kind, keychain_ref, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(id, input.type, input.displayName, input.authKind, keychainRef, ts, ts);

  return getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow;
};

export const markProviderUsed = (providerId: string): void => {
  const ts = now();
  getDb().prepare('UPDATE providers SET updated_at = ?, last_used_at = ? WHERE id = ?').run(ts, ts, providerId);
};

export const getProviderById = (providerId: string): ProviderRow | undefined => {
  return getDb().prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as ProviderRow | undefined;
};

export const createWorkspace = (input: { name: string; rootPath: string; trustLevel: WorkspaceRow['trust_level'] }): WorkspaceRow => {
  const ts = now();
  const id = makeId('ws');

  getDb()
    .prepare(
      `INSERT INTO workspace_projects (id, name, root_path, trust_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.name, input.rootPath, input.trustLevel, ts, ts);

  return getDb().prepare('SELECT * FROM workspace_projects WHERE id = ?').get(id) as WorkspaceRow;
};

export const listWorkspaces = (): WorkspaceRow[] => {
  return getDb().prepare('SELECT * FROM workspace_projects ORDER BY updated_at DESC').all() as WorkspaceRow[];
};

export const getWorkspaceById = (workspaceId: string): WorkspaceRow | undefined => {
  return getDb().prepare('SELECT * FROM workspace_projects WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
};

export const createSession = (input: {
  title: string;
  providerId: string;
  workspaceId?: string;
  modelProfileId?: string;
}): SessionRow => {
  const id = makeId('sess');
  const ts = now();

  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, title, provider_id, model_profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(id, input.workspaceId ?? null, input.title, input.providerId, input.modelProfileId ?? null, ts, ts);

  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow;
};

export const setSessionProvider = (input: { sessionId: string; providerId: string }): SessionRow => {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE sessions
       SET provider_id = ?, model_profile_id = NULL, updated_at = ?
       WHERE id = ?`
    )
    .run(input.providerId, ts, input.sessionId);

  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(input.sessionId) as SessionRow;
};

export const setSessionTitle = (input: { sessionId: string; title: string }): SessionRow => {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE sessions
       SET title = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(input.title, ts, input.sessionId);

  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(input.sessionId) as SessionRow;
};

export const listSessions = (): SessionRow[] => {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE status != ? ORDER BY COALESCE(last_message_at, updated_at) DESC')
    .all('archived') as SessionRow[];
};

export const getSessionById = (sessionId: string): SessionRow | undefined => {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
};

export const getModelProfileById = (modelProfileId: string): ModelProfileRow | undefined => {
  return getDb().prepare('SELECT * FROM model_profiles WHERE id = ?').get(modelProfileId) as ModelProfileRow | undefined;
};

export const listModelProfilesByProvider = (providerId: string): ModelProfileRow[] => {
  return getDb()
    .prepare('SELECT * FROM model_profiles WHERE provider_id = ? ORDER BY is_default DESC, model_id ASC')
    .all(providerId) as ModelProfileRow[];
};

const DEFAULT_MODEL_PRIORITY = [
  'gpt-5-codex',
  'gpt-5.3-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-4.1',
  'gpt-4o-mini',
  'o3',
  'o4-mini'
];

export const replaceProviderModelProfiles = (providerId: string, modelIds: string[]): ModelProfileRow[] => {
  const uniqueModelIds = modelIds
    .map((value) => value.trim())
    .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);

  if (uniqueModelIds.length === 0) {
    getDb().prepare('DELETE FROM model_profiles WHERE provider_id = ?').run(providerId);
    return [];
  }

  const existingDefault = getDb()
    .prepare('SELECT model_id FROM model_profiles WHERE provider_id = ? AND is_default = 1 LIMIT 1')
    .get(providerId) as { model_id?: string } | undefined;

  const preferredDefault = existingDefault?.model_id && uniqueModelIds.includes(existingDefault.model_id)
    ? existingDefault.model_id
    : DEFAULT_MODEL_PRIORITY.find((modelId) => uniqueModelIds.includes(modelId)) ?? uniqueModelIds[0];

  const ts = now();
  const tx = getDb().transaction(() => {
    getDb().prepare('DELETE FROM model_profiles WHERE provider_id = ?').run(providerId);

    const insert = getDb().prepare(
      `INSERT INTO model_profiles (
        id, provider_id, model_id, label, temperature, top_p, max_output_tokens, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
    );

    for (const modelId of uniqueModelIds) {
      insert.run(makeId('model'), providerId, modelId, modelId, modelId === preferredDefault ? 1 : 0, ts, ts);
    }
  });

  tx();
  return listModelProfilesByProvider(providerId);
};

export const archiveSession = (sessionId: string): void => {
  getDb().prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run('archived', now(), sessionId);
};

export const listMessages = (sessionId: string): MessageRow[] => {
  return getDb().prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as MessageRow[];
};

export const getMessageById = (messageId: string): MessageRow | undefined => {
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
};

const getNextMessageSeq = (sessionId: string): number => {
  const row = getDb().prepare('SELECT COALESCE(MAX(seq), -1) as seq FROM messages WHERE session_id = ?').get(sessionId) as {
    seq: number;
  };
  return row.seq + 1;
};

export const addMessage = (input: {
  sessionId: string;
  role: MessageRow['role'];
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
}): MessageRow => {
  const id = makeId('msg');
  const ts = now();
  const seq = getNextMessageSeq(input.sessionId);

  getDb()
    .prepare(
      `INSERT INTO messages (
        id, session_id, role, content, content_format, seq, input_tokens, output_tokens, cost_microunits, created_at
      ) VALUES (?, ?, ?, ?, 'markdown', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.sessionId,
      input.role,
      input.content,
      seq,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.costMicrounits ?? null,
      ts
    );

  getDb().prepare('UPDATE sessions SET updated_at = ?, last_message_at = ? WHERE id = ?').run(ts, ts, input.sessionId);

  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
};

export const getAssistantRunByClientRequest = (input: {
  sessionId: string;
  clientRequestId: string;
}): AssistantRunRow | undefined => {
  return getDb()
    .prepare('SELECT * FROM assistant_runs WHERE session_id = ? AND client_request_id = ?')
    .get(input.sessionId, input.clientRequestId) as AssistantRunRow | undefined;
};

export const listAssistantRunsByStatus = (status: AssistantRunRow['status']): AssistantRunRow[] => {
  return getDb()
    .prepare('SELECT * FROM assistant_runs WHERE status = ? ORDER BY created_at ASC')
    .all(status) as AssistantRunRow[];
};

export const createAssistantRun = (input: {
  sessionId: string;
  clientRequestId: string;
  streamId: string;
}): AssistantRunRow => {
  const ts = now();
  const id = makeId('run');

  getDb()
    .prepare(
      `INSERT INTO assistant_runs (
        id, session_id, client_request_id, stream_id, status, user_message_id, assistant_message_id, error_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?)`
    )
    .run(id, input.sessionId, input.clientRequestId, input.streamId, ts, ts);

  return getDb().prepare('SELECT * FROM assistant_runs WHERE id = ?').get(id) as AssistantRunRow;
};

export const markAssistantRunUserMessage = (input: {
  runId: string;
  userMessageId: string;
}): void => {
  getDb()
    .prepare('UPDATE assistant_runs SET user_message_id = ?, updated_at = ? WHERE id = ?')
    .run(input.userMessageId, now(), input.runId);
};

export const completeAssistantRun = (input: {
  runId: string;
  assistantMessageId: string;
  errorText?: string;
}): void => {
  getDb()
    .prepare(
      'UPDATE assistant_runs SET assistant_message_id = ?, status = ?, error_text = ?, updated_at = ? WHERE id = ?'
    )
    .run(input.assistantMessageId, 'completed', input.errorText ?? null, now(), input.runId);
};

export const failAssistantRun = (input: {
  runId: string;
  errorText: string;
}): void => {
  getDb()
    .prepare('UPDATE assistant_runs SET status = ?, error_text = ?, updated_at = ? WHERE id = ?')
    .run('failed', input.errorText, now(), input.runId);
};

export const markAssistantRunRecovered = (input: {
  runId: string;
  status: AssistantRunRow['status'];
  assistantMessageId?: string;
  errorText?: string;
}): void => {
  getDb()
    .prepare(
      'UPDATE assistant_runs SET status = ?, assistant_message_id = COALESCE(?, assistant_message_id), error_text = ?, updated_at = ? WHERE id = ?'
    )
    .run(input.status, input.assistantMessageId ?? null, input.errorText ?? null, now(), input.runId);
};

export const getSetting = (key: string): unknown | null => {
  const row = getDb().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) : null;
};

export const setSetting = (key: string, value: unknown): void => {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), ts);
};

export const recordUsageEvent = (input: {
  providerId: string;
  sessionId?: string;
  messageId?: string;
  eventType: 'completion' | 'embedding' | 'tool';
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
}): void => {
  getDb()
    .prepare(
      `INSERT INTO usage_events (
        id, provider_id, session_id, message_id, event_type, input_tokens, output_tokens, cost_microunits, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      makeId('use'),
      input.providerId,
      input.sessionId ?? null,
      input.messageId ?? null,
      input.eventType,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.costMicrounits ?? 0,
      now()
    );
};

export const summarizeUsage = (days: number): { input_tokens: number; output_tokens: number; cost_microunits: number } => {
  const lowerBound = now() - days * 24 * 60 * 60 * 1000;
  const row = getDb()
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_microunits), 0) as cost_microunits
      FROM usage_events
      WHERE created_at >= ?`
    )
    .get(lowerBound) as {
      input_tokens: number;
      output_tokens: number;
      cost_microunits: number;
    };

  return row;
};
