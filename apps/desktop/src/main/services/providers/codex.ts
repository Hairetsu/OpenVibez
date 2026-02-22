import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

type DeviceAuthStatus = 'idle' | 'pending' | 'success' | 'error';

type TraceKind = 'thought' | 'plan' | 'action';

type ActionKind = 'file-edit' | 'file-read' | 'file-create' | 'file-delete' | 'search' | 'command' | 'command-result' | 'generic';

type CodexStreamEvent =
  | { type: 'status'; text: string }
  | { type: 'trace'; traceKind: TraceKind; text: string; actionKind?: ActionKind }
  | { type: 'assistant_delta'; delta: string };

export type CodexDeviceAuthState = {
  status: DeviceAuthStatus;
  verificationUri?: string;
  userCode?: string;
  message?: string;
  startedAt?: number;
  updatedAt: number;
};

export type CodexCompletionInput = {
  history: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  cwd?: string;
  model?: string;
  fullAccess?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: CodexStreamEvent) => void;
};

export type CodexCompletionResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

let deviceAuthState: CodexDeviceAuthState = {
  status: 'idle',
  updatedAt: Date.now()
};

let deviceAuthInFlight: Promise<CodexDeviceAuthState> | null = null;
let resolvedCodexCommand: string | null = null;

const ANSI = /\x1B\[[0-9;]*m/g;

const stripAnsi = (text: string): string => text.replace(ANSI, '');

const codexNotFoundMessage =
  'Codex CLI not found for Electron. Set OPENVIBEZ_CODEX_BIN (for example: /Applications/Codex.app/Contents/Resources/codex).';

const canExecute = (candidate: string): boolean => {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveCodexCommand = (): string => {
  if (resolvedCodexCommand) {
    return resolvedCodexCommand;
  }

  const configured = process.env.OPENVIBEZ_CODEX_BIN;
  const candidates = [
    configured,
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex'
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (canExecute(candidate)) {
      resolvedCodexCommand = candidate;
      return candidate;
    }
  }

  resolvedCodexCommand = 'codex';
  return resolvedCodexCommand;
};

const mapSpawnError = (error: unknown): Error => {
  if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
    return new Error(codexNotFoundMessage);
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error('Failed to run Codex CLI.');
};

const parseDeviceAuthOutput = (output: string): { verificationUri?: string; userCode?: string } => {
  const clean = stripAnsi(output);

  const urlMatch = clean.match(/https:\/\/auth\.openai\.com\/codex\/device/);
  const codeMatch = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);

  return {
    verificationUri: urlMatch?.[0],
    userCode: codeMatch?.[0]
  };
};

const classifyReasoning = (text: string): TraceKind => {
  if (/\b(plan|step|first|next|then|finally|roadmap|todo)\b/i.test(text)) {
    return 'plan';
  }

  return 'thought';
};

const classifyAction = (itemType: string, itemName: string, text: string): ActionKind => {
  const combo = `${itemType} ${itemName}`.toLowerCase();

  if (/write|patch|edit|update|apply/i.test(combo) || /\*\*\*\s+Update\s+File:/i.test(text)) {
    return 'file-edit';
  }
  if (/create|add|mkdir/i.test(combo) || /\*\*\*\s+Add\s+File:/i.test(text)) {
    return 'file-create';
  }
  if (/delete|remove|rm\b/i.test(combo) || /\*\*\*\s+Delete\s+File:/i.test(text)) {
    return 'file-delete';
  }
  if (/read|cat|head|tail|view/i.test(combo)) {
    return 'file-read';
  }
  if (/search|grep|rg\b|find|glob|list_dir|ls\b/i.test(combo)) {
    return 'search';
  }
  if (/shell|exec|command|bash|run|terminal/i.test(combo)) {
    return 'command';
  }
  if (/output|result/i.test(itemType)) {
    return 'command-result';
  }

  if (/^exit:\s*/i.test(text.split('\n', 1)[0] ?? '')) {
    return 'command-result';
  }
  if (/^Step\s+\d+\s+command:/i.test(text.split('\n', 1)[0] ?? '')) {
    return 'command';
  }

  return 'generic';
};

const extractItemText = (item: Record<string, unknown>): string => {
  const raw = item.text;
  if (typeof raw === 'string' && raw.trim()) {
    return raw;
  }

  const alt = item.message;
  if (typeof alt === 'string' && alt.trim()) {
    return alt;
  }

  const output = item.output;
  if (typeof output === 'string' && output.trim()) {
    return output;
  }

  const name = typeof item.name === 'string' ? item.name : '';
  const args = item.arguments;
  if (name && typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const filePath = parsed.path ?? parsed.file ?? parsed.filename;
      if (typeof filePath === 'string') {
        return `${name}: ${filePath}`;
      }
      const cmd = parsed.command ?? parsed.cmd;
      if (typeof cmd === 'string') {
        return `${name}: ${cmd}`;
      }
      const query = parsed.query ?? parsed.pattern ?? parsed.search;
      if (typeof query === 'string') {
        return `${name}: ${query}`;
      }
      return `${name}: ${args}`;
    } catch {
      return `${name}: ${args}`;
    }
  }

  if (name) {
    return name;
  }

  return '';
};

const buildCodexPrompt = (history: CodexCompletionInput['history']): string => {
  const transcript = history
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n');

  return [
    'You are OpenVibez assistant.',
    'Continue this conversation and respond as the assistant to the latest user message.',
    'Keep response focused and actionable.',
    '',
    transcript,
    '',
    'ASSISTANT:'
  ].join('\n');
};

type CodexModelsCache = {
  models?: Array<{
    slug?: unknown;
    visibility?: unknown;
    priority?: unknown;
  }>;
};

const getCodexHome = (): string => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

export const listCodexAvailableModels = async (): Promise<string[]> => {
  const cachePath = path.join(getCodexHome(), 'models_cache.json');

  let payload: CodexModelsCache | null = null;
  try {
    const content = await fs.readFile(cachePath, 'utf8');
    payload = JSON.parse(content) as CodexModelsCache;
  } catch {
    payload = null;
  }

  const all = (payload?.models ?? [])
    .map((entry) => ({
      slug: typeof entry.slug === 'string' ? entry.slug : '',
      visibility: typeof entry.visibility === 'string' ? entry.visibility : '',
      priority: typeof entry.priority === 'number' ? entry.priority : Number.POSITIVE_INFINITY
    }))
    .filter((entry) => entry.slug.length > 0);

  if (all.length === 0) {
    return ['gpt-5-codex'];
  }

  const visible = all.filter((entry) => entry.visibility === 'list');
  const basis = visible.length > 0 ? visible : all;

  basis.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.slug.localeCompare(b.slug);
  });

  const unique: string[] = [];
  for (const entry of basis) {
    if (!unique.includes(entry.slug)) {
      unique.push(entry.slug);
    }
  }

  return unique;
};

export const getCodexLoginStatus = async (): Promise<{ loggedIn: boolean; detail: string }> => {
  return new Promise((resolve) => {
    const child = spawn(resolveCodexCommand(), ['login', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      resolve({ loggedIn: false, detail: mapSpawnError(error).message });
    });

    child.on('close', (code) => {
      const output = stripAnsi(`${stdout}\n${stderr}`.trim());
      const loggedIn = code === 0 && /logged in/i.test(output);
      resolve({
        loggedIn,
        detail: output || (loggedIn ? 'Logged in' : 'Not logged in')
      });
    });
  });
};

export const startCodexDeviceAuth = async (): Promise<CodexDeviceAuthState> => {
  if (deviceAuthState.status === 'pending' && deviceAuthState.verificationUri && deviceAuthState.userCode) {
    return deviceAuthState;
  }

  if (deviceAuthInFlight) {
    return deviceAuthInFlight;
  }

  const startedAt = Date.now();
  deviceAuthState = {
    status: 'pending',
    startedAt,
    updatedAt: startedAt,
    message: 'Starting device auth...'
  };

  deviceAuthInFlight = new Promise((resolve, reject) => {
    const child = spawn(resolveCodexCommand(), ['login', '--device-auth'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let combined = '';
    let resolved = false;

    const maybeResolve = () => {
      const parsed = parseDeviceAuthOutput(combined);
      if (!parsed.verificationUri || !parsed.userCode) {
        return;
      }

      deviceAuthState = {
        status: 'pending',
        startedAt,
        updatedAt: Date.now(),
        verificationUri: parsed.verificationUri,
        userCode: parsed.userCode,
        message: 'Open the link, enter the code, then return to OpenVibez and press Check Support.'
      };

      if (!resolved) {
        resolved = true;
        resolve(deviceAuthState);
      }
    };

    const onData = (chunk: Buffer | string) => {
      combined += String(chunk);
      maybeResolve();
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (error) => {
      const mapped = mapSpawnError(error);
      deviceAuthState = {
        status: 'error',
        startedAt,
        updatedAt: Date.now(),
        message: mapped.message
      };

      deviceAuthInFlight = null;
      if (!resolved) {
        resolved = true;
        reject(mapped);
      }
    });

    child.on('close', (code) => {
      const output = stripAnsi(combined.trim());
      if (code === 0) {
        deviceAuthState = {
          ...deviceAuthState,
          status: 'success',
          updatedAt: Date.now(),
          message: output || 'Subscription login completed.'
        };
      } else {
        deviceAuthState = {
          ...deviceAuthState,
          status: 'error',
          updatedAt: Date.now(),
          message: output || `Device auth exited with code ${code ?? 'unknown'}`
        };
      }

      deviceAuthInFlight = null;
    });

    setTimeout(() => {
      maybeResolve();
      if (!resolved) {
        deviceAuthState = {
          status: 'error',
          startedAt,
          updatedAt: Date.now(),
          message: 'Unable to parse device auth details from codex output.'
        };
        deviceAuthInFlight = null;
        reject(new Error(deviceAuthState.message));
      }
    }, 5000);
  });

  return deviceAuthInFlight;
};

export const getCodexDeviceAuthState = (): CodexDeviceAuthState => deviceAuthState;

export const createCodexCompletion = async (input: CodexCompletionInput): Promise<CodexCompletionResult> => {
  const messagePath = path.join(os.tmpdir(), `openvibez-codex-${randomUUID()}.txt`);
  const prompt = buildCodexPrompt(input.history);

  const args = ['exec', '--skip-git-repo-check', '--json', '--output-last-message', messagePath];

  if (input.fullAccess) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'workspace-write');
  }

  if (input.model) {
    args.push('--model', input.model);
  }

  if (input.cwd) {
    args.push('-C', input.cwd);
  }

  args.push(prompt);
  input.onEvent?.({ type: 'status', text: input.fullAccess ? 'Running with root-level access...' : 'Running in scoped workspace mode...' });

  const { stdout, stderr, code, usage, assistantText } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    usage: { inputTokens?: number; outputTokens?: number };
    assistantText: string;
  }>((resolve, reject) => {
    if (input.signal?.aborted) {
      const abortError = new Error('Request cancelled by user.');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }

    const child = spawn(resolveCodexCommand(), args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let assistantText = '';
    let usage: { inputTokens?: number; outputTokens?: number } = {};
    let lineBuffer = '';
    let settled = false;
    let onAbort: (() => void) | null = null;

    const done = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (input.signal && onAbort) {
        input.signal.removeEventListener('abort', onAbort);
      }
      fn();
    };

    onAbort = () => {
      const abortError = new Error('Request cancelled by user.');
      abortError.name = 'AbortError';
      try {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      } catch {
        // ignore process kill errors
      }
      done(() => reject(abortError));
    };

    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) {
        return;
      }

      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }

      const parsed = event as {
        type?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        item?: Record<string, unknown>;
      };

      if (parsed.type === 'turn.started') {
        input.onEvent?.({ type: 'status', text: 'Planning...' });
        return;
      }

      if (parsed.type === 'turn.completed' && parsed.usage) {
        usage = {
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens
        };
        input.onEvent?.({ type: 'status', text: 'Finalizing response...' });
        return;
      }

      if (parsed.type !== 'item.completed' || !parsed.item) {
        return;
      }

      const itemType = typeof parsed.item.type === 'string' ? parsed.item.type : '';
      const itemName = typeof parsed.item.name === 'string' ? parsed.item.name : '';
      const text = extractItemText(parsed.item);
      if (!text && !itemName && !itemType) {
        return;
      }

      if (itemType === 'reasoning') {
        input.onEvent?.({
          type: 'trace',
          traceKind: classifyReasoning(text),
          text
        });
        return;
      }

      if (itemType === 'agent_message') {
        assistantText += text;
        input.onEvent?.({ type: 'assistant_delta', delta: text });
        return;
      }

      const traceText = text || `${itemName || itemType}`;
      input.onEvent?.({
        type: 'trace',
        traceKind: 'action',
        text: traceText,
        actionKind: classifyAction(itemType, itemName, traceText)
      });
    };

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;

      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      done(() => reject(mapSpawnError(error)));
    });

    child.on('close', (childCode) => {
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
      }

      done(() => resolve({ stdout, stderr, code: childCode, usage, assistantText }));
    });
  });

  if (code !== 0) {
    throw new Error(stripAnsi(stderr.trim() || stdout.trim() || `codex exec failed with code ${code ?? 'unknown'}`));
  }

  let text = '';
  try {
    text = (await fs.readFile(messagePath, 'utf8')).trim();
  } catch {
    text = '';
  }
  void fs.unlink(messagePath).catch(() => {});

  if (!text && assistantText.trim()) {
    text = assistantText.trim();
  }

  if (!text) {
    throw new Error('codex exec returned empty output');
  }

  return {
    text,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens
  };
};
