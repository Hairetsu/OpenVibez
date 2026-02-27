type HistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export type OllamaToolCall = {
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type OllamaToolMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: OllamaToolCall[];
};

type OllamaCompletionInput = {
  baseUrl?: string;
  model: string;
  history: HistoryMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  numCtx?: number;
  stream?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: { type: 'status' | 'assistant_delta'; text?: string; delta?: string }) => void;
};

type OllamaCompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

type OllamaToolTurnInput = {
  baseUrl?: string;
  model: string;
  messages: OllamaToolMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  numCtx?: number;
  tools: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  signal?: AbortSignal;
};

type OllamaToolTurnResult = {
  text: string;
  model: string;
  toolCalls: OllamaToolCall[];
  assistantMessage: OllamaToolMessage;
  inputTokens?: number;
  outputTokens?: number;
};

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

const mapRole = (role: HistoryMessage['role']): 'system' | 'user' | 'assistant' => {
  if (role === 'tool') {
    return 'assistant';
  }

  return role;
};

const mapRoleForTools = (role: HistoryMessage['role']): 'system' | 'user' | 'assistant' | 'tool' => role;

const normalizeBaseUrl = (value?: string): string => {
  const raw = value?.trim() || DEFAULT_OLLAMA_BASE_URL;
  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid Ollama URL: "${raw}"`);
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
};

const makeOllamaUrl = (baseUrl: string, endpointPath: string): string => {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(endpointPath.replace(/^\//, ''), base).toString();
};

const parseConnectionError = async (res: Response): Promise<string> => {
  const payload = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const message = typeof payload?.error === 'string'
    ? payload.error
    : typeof payload?.message === 'string'
      ? payload.message
      : null;

  if (message?.trim()) {
    return message;
  }

  return `Ollama request failed (${res.status})`;
};

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Unable to reach Ollama.';
};

export const testOllamaConnection = async (baseUrl?: string): Promise<{ ok: boolean; status: number; reason?: string }> => {
  try {
    const resolvedBase = normalizeBaseUrl(baseUrl);
    const res = await fetch(makeOllamaUrl(resolvedBase, '/api/tags'), { method: 'GET' });

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    return {
      ok: false,
      status: res.status,
      reason: await parseConnectionError(res)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: asErrorMessage(error)
    };
  }
};

export const listOllamaModels = async (baseUrl?: string): Promise<string[]> => {
  const resolvedBase = normalizeBaseUrl(baseUrl);
  let res: Response;
  try {
    res = await fetch(makeOllamaUrl(resolvedBase, '/api/tags'), { method: 'GET' });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseConnectionError(res));
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        models?: Array<{ name?: unknown; model?: unknown }>;
      }
    | null;

  const modelIds = (payload?.models ?? [])
    .map((entry) => {
      if (typeof entry?.name === 'string' && entry.name.trim()) {
        return entry.name.trim();
      }
      if (typeof entry?.model === 'string' && entry.model.trim()) {
        return entry.model.trim();
      }
      return '';
    })
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((a, b) => a.localeCompare(b));

  return modelIds;
};

export const createOllamaCompletion = async (input: OllamaCompletionInput): Promise<OllamaCompletionResult> => {
  const useStream = input.stream ?? true;
  input.onEvent?.({ type: 'status', text: useStream ? 'Streaming local response...' : 'Running local response...' });

  const resolvedBase = normalizeBaseUrl(input.baseUrl);
  const options: Record<string, unknown> = {};

  if (typeof input.temperature === 'number') {
    options.temperature = input.temperature;
  }

  if (typeof input.maxOutputTokens === 'number') {
    options.num_predict = input.maxOutputTokens;
  }
  if (typeof input.numCtx === 'number' && Number.isFinite(input.numCtx)) {
    options.num_ctx = Math.max(256, Math.trunc(input.numCtx));
  }

  const body: Record<string, unknown> = {
    model: input.model,
    stream: useStream,
    messages: input.history.map((message) => ({
      role: mapRole(message.role),
      content: message.content
    }))
  };

  if (Object.keys(options).length > 0) {
    body.options = options;
  }

  let res: Response;
  try {
    res = await fetch(makeOllamaUrl(resolvedBase, '/api/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: input.signal,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseConnectionError(res));
  }

  if (!useStream) {
    const payload = (await res.json().catch(() => null)) as
      | {
          error?: unknown;
          model?: unknown;
          message?: { content?: unknown };
          prompt_eval_count?: unknown;
          eval_count?: unknown;
        }
      | null;

    if (typeof payload?.error === 'string' && payload.error.trim()) {
      throw new Error(payload.error);
    }

    const model = typeof payload?.model === 'string' && payload.model.trim() ? payload.model : input.model;
    const text = typeof payload?.message?.content === 'string' ? payload.message.content.trim() : '';
    const inputTokens =
      typeof payload?.prompt_eval_count === 'number' && Number.isFinite(payload.prompt_eval_count)
        ? payload.prompt_eval_count
        : undefined;
    const outputTokens =
      typeof payload?.eval_count === 'number' && Number.isFinite(payload.eval_count)
        ? payload.eval_count
        : undefined;

    if (!text) {
      throw new Error('Ollama returned an empty response.');
    }

    return {
      text,
      model,
      inputTokens,
      outputTokens
    };
  }

  if (!res.body) {
    throw new Error('Ollama response body is unavailable for streaming.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let fullText = '';
  let model = input.model;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const processLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    const parsed = payload as {
      error?: unknown;
      model?: unknown;
      message?: { content?: unknown };
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    };

    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      throw new Error(parsed.error);
    }

    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      model = parsed.model;
    }

    if (typeof parsed.prompt_eval_count === 'number' && Number.isFinite(parsed.prompt_eval_count)) {
      inputTokens = parsed.prompt_eval_count;
    }

    if (typeof parsed.eval_count === 'number' && Number.isFinite(parsed.eval_count)) {
      outputTokens = parsed.eval_count;
    }

    const delta = typeof parsed.message?.content === 'string' ? parsed.message.content : '';
    if (delta) {
      fullText += delta;
      input.onEvent?.({ type: 'assistant_delta', delta });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      processLine(line);
      boundary = buffer.indexOf('\n');
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    processLine(remaining);
  }

  if (!fullText.trim()) {
    throw new Error('Ollama returned an empty response.');
  }

  return {
    text: fullText,
    model,
    inputTokens,
    outputTokens
  };
};

const parseToolCallArguments = (value: unknown): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }

    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const normalizeToolCalls = (value: unknown): OllamaToolCall[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OllamaToolCall[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const entry = raw as { type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof entry.function?.name === 'string' ? entry.function.name.trim() : '';
    if (!name) {
      continue;
    }

    normalized.push({
      type: 'function',
      function: {
        name,
        arguments: parseToolCallArguments(entry.function?.arguments)
      }
    });
  }

  return normalized;
};

export const createOllamaToolTurn = async (input: OllamaToolTurnInput): Promise<OllamaToolTurnResult> => {
  const resolvedBase = normalizeBaseUrl(input.baseUrl);
  let res: Response;
  const options: Record<string, unknown> = {};

  if (typeof input.temperature === 'number') {
    options.temperature = input.temperature;
  }
  if (typeof input.maxOutputTokens === 'number') {
    options.num_predict = input.maxOutputTokens;
  }
  if (typeof input.numCtx === 'number' && Number.isFinite(input.numCtx)) {
    options.num_ctx = Math.max(256, Math.trunc(input.numCtx));
  }

  try {
    res = await fetch(makeOllamaUrl(resolvedBase, '/api/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        stream: false,
        messages: input.messages.map((message) => ({
          role: mapRoleForTools(message.role),
          content: message.content,
          ...(message.toolCalls ? { tool_calls: message.toolCalls } : {})
        })),
        tools: input.tools,
        ...(Object.keys(options).length > 0 ? { options } : {})
      })
    });
  } catch (error) {
    throw new Error(asErrorMessage(error));
  }

  if (!res.ok) {
    throw new Error(await parseConnectionError(res));
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        error?: unknown;
        model?: unknown;
        message?: {
          role?: unknown;
          content?: unknown;
          tool_calls?: unknown;
        };
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      }
    | null;

  if (typeof payload?.error === 'string' && payload.error.trim()) {
    throw new Error(payload.error);
  }

  const model = typeof payload?.model === 'string' && payload.model.trim() ? payload.model : input.model;
  const text = typeof payload?.message?.content === 'string' ? payload.message.content : '';
  const toolCalls = normalizeToolCalls(payload?.message?.tool_calls);
  const inputTokens =
    typeof payload?.prompt_eval_count === 'number' && Number.isFinite(payload.prompt_eval_count)
      ? payload.prompt_eval_count
      : undefined;
  const outputTokens =
    typeof payload?.eval_count === 'number' && Number.isFinite(payload.eval_count)
      ? payload.eval_count
      : undefined;

  const assistantMessage: OllamaToolMessage = {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {})
  };

  return {
    text,
    model,
    toolCalls,
    assistantMessage,
    inputTokens,
    outputTokens
  };
};

export const getOllamaDiagnostics = async (baseUrl?: string): Promise<{
  baseUrl: string;
  reachable: boolean;
  tagsStatus: number;
  latencyMs: number;
  modelCount: number;
  runningModelCount: number;
  version?: string;
  error?: string;
}> => {
  const resolvedBase = normalizeBaseUrl(baseUrl);
  const started = Date.now();

  try {
    const tagsRes = await fetch(makeOllamaUrl(resolvedBase, '/api/tags'), { method: 'GET' });
    const latencyMs = Date.now() - started;
    const tagsPayload = (await tagsRes.json().catch(() => null)) as
      | { models?: Array<unknown> }
      | null;

    let runningModelCount = 0;
    try {
      const psRes = await fetch(makeOllamaUrl(resolvedBase, '/api/ps'), { method: 'GET' });
      if (psRes.ok) {
        const psPayload = (await psRes.json().catch(() => null)) as
          | { models?: Array<unknown> }
          | null;
        runningModelCount = Array.isArray(psPayload?.models) ? psPayload.models.length : 0;
      }
    } catch {
      runningModelCount = 0;
    }

    let version: string | undefined;
    try {
      const versionRes = await fetch(makeOllamaUrl(resolvedBase, '/api/version'), { method: 'GET' });
      if (versionRes.ok) {
        const versionPayload = (await versionRes.json().catch(() => null)) as { version?: unknown } | null;
        if (typeof versionPayload?.version === 'string' && versionPayload.version.trim()) {
          version = versionPayload.version.trim();
        }
      }
    } catch {
      version = undefined;
    }

    return {
      baseUrl: resolvedBase,
      reachable: tagsRes.ok,
      tagsStatus: tagsRes.status,
      latencyMs,
      modelCount: Array.isArray(tagsPayload?.models) ? tagsPayload.models.length : 0,
      runningModelCount,
      version,
      ...(tagsRes.ok ? {} : { error: await parseConnectionError(tagsRes) })
    };
  } catch (error) {
    return {
      baseUrl: resolvedBase,
      reachable: false,
      tagsStatus: 0,
      latencyMs: Date.now() - started,
      modelCount: 0,
      runningModelCount: 0,
      error: asErrorMessage(error)
    };
  }
};
