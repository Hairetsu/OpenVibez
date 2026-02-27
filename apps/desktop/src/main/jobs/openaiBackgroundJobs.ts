import {
  addMessage,
  completeAssistantRun,
  getAssistantRunById,
  getProviderById,
  listBackgroundJobs,
  markProviderUsed,
  recordUsageEvent,
  updateBackgroundJob
} from '../services/db';
import { getSecret } from '../services/keychain';
import {
  getOpenAIBackgroundJobKind,
  isOpenAITerminalStatus,
  retrieveOpenAIBackgroundResponse,
  type OpenAIBackgroundJobPayload
} from '../services/providers/openai';
import { logger } from '../util/logger';

const OPENAI_BACKGROUND_JOB_MAX_ATTEMPTS = 120;

const asBackgroundPayload = (value: unknown): OpenAIBackgroundJobPayload | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as {
    responseId?: unknown;
    providerId?: unknown;
    sessionId?: unknown;
    runId?: unknown;
    clientRequestId?: unknown;
    model?: unknown;
    status?: unknown;
    updatedAt?: unknown;
  };

  if (
    typeof payload.responseId !== 'string' ||
    typeof payload.providerId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.runId !== 'string' ||
    typeof payload.clientRequestId !== 'string' ||
    typeof payload.model !== 'string'
  ) {
    return null;
  }

  return {
    responseId: payload.responseId,
    providerId: payload.providerId,
    sessionId: payload.sessionId,
    runId: payload.runId,
    clientRequestId: payload.clientRequestId,
    model: payload.model,
    status: typeof payload.status === 'string' ? payload.status : 'queued',
    updatedAt: typeof payload.updatedAt === 'number' && Number.isFinite(payload.updatedAt) ? payload.updatedAt : Date.now()
  };
};

const buildFailureAssistantText = (message: string): string => `Provider request failed: ${message}`;

const finalizeRunFromBackgroundResult = (input: {
  runId: string;
  sessionId: string;
  providerId: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  errorText?: string;
}): void => {
  const run = getAssistantRunById(input.runId);
  if (!run || run.status !== 'running') {
    return;
  }

  if (run.assistant_message_id) {
    completeAssistantRun({
      runId: run.id,
      assistantMessageId: run.assistant_message_id,
      errorText: input.errorText
    });
    return;
  }

  const assistantMessage = addMessage({
    sessionId: input.sessionId,
    role: 'assistant',
    content: input.text,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens
  });

  completeAssistantRun({
    runId: run.id,
    assistantMessageId: assistantMessage.id,
    errorText: input.errorText
  });

  markProviderUsed(input.providerId);
  recordUsageEvent({
    providerId: input.providerId,
    sessionId: input.sessionId,
    messageId: assistantMessage.id,
    eventType: 'completion',
    inputTokens: input.inputTokens ?? Math.ceil(input.text.length / 4),
    outputTokens: input.outputTokens ?? Math.ceil(input.text.length / 4),
    costMicrounits: 0
  });
};

const markJobFailed = (jobId: string, payload: OpenAIBackgroundJobPayload, attempts: number, reason: string): void => {
  updateBackgroundJob({
    id: jobId,
    state: 'failed',
    payload: {
      ...payload,
      status: 'failed',
      updatedAt: Date.now()
    },
    attemptCount: attempts,
    lastError: reason
  });
};

const processOpenAIBackgroundJob = async (job: {
  id: string;
  payload: unknown;
  attempt_count: number;
}): Promise<void> => {
  const payload = asBackgroundPayload(job.payload);
  if (!payload) {
    updateBackgroundJob({
      id: job.id,
      state: 'failed',
      attemptCount: job.attempt_count + 1,
      lastError: 'Invalid OpenAI background job payload.'
    });
    return;
  }

  if (job.attempt_count >= OPENAI_BACKGROUND_JOB_MAX_ATTEMPTS) {
    const timeoutError = `OpenAI background job exceeded max attempts (${OPENAI_BACKGROUND_JOB_MAX_ATTEMPTS}).`;
    finalizeRunFromBackgroundResult({
      runId: payload.runId,
      sessionId: payload.sessionId,
      providerId: payload.providerId,
      text: buildFailureAssistantText(timeoutError),
      errorText: timeoutError
    });
    markJobFailed(job.id, payload, job.attempt_count, timeoutError);
    return;
  }

  const provider = getProviderById(payload.providerId);
  if (!provider || provider.type !== 'openai' || provider.auth_kind !== 'api_key' || !provider.keychain_ref) {
    const errorText = 'OpenAI background job has invalid provider configuration.';
    finalizeRunFromBackgroundResult({
      runId: payload.runId,
      sessionId: payload.sessionId,
      providerId: payload.providerId,
      text: buildFailureAssistantText(errorText),
      errorText
    });
    markJobFailed(job.id, payload, job.attempt_count + 1, errorText);
    return;
  }

  const apiKey = await getSecret(provider.keychain_ref);
  if (!apiKey) {
    const errorText = 'OpenAI API key is unavailable for background job recovery.';
    finalizeRunFromBackgroundResult({
      runId: payload.runId,
      sessionId: payload.sessionId,
      providerId: payload.providerId,
      text: buildFailureAssistantText(errorText),
      errorText
    });
    markJobFailed(job.id, payload, job.attempt_count + 1, errorText);
    return;
  }

  try {
    const snapshot = await retrieveOpenAIBackgroundResponse({
      apiKey,
      responseId: payload.responseId
    });

    if (!isOpenAITerminalStatus(snapshot.status)) {
      updateBackgroundJob({
        id: job.id,
        state: 'running',
        payload: {
          ...payload,
          status: snapshot.status ?? payload.status,
          model: snapshot.model || payload.model,
          updatedAt: Date.now()
        },
        attemptCount: job.attempt_count + 1,
        lastError: null
      });
      return;
    }

    if (snapshot.status === 'completed' && snapshot.text.trim()) {
      finalizeRunFromBackgroundResult({
        runId: payload.runId,
        sessionId: payload.sessionId,
        providerId: payload.providerId,
        text: snapshot.text,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens
      });
      updateBackgroundJob({
        id: job.id,
        state: 'completed',
        payload: {
          ...payload,
          status: 'completed',
          model: snapshot.model || payload.model,
          updatedAt: Date.now()
        },
        attemptCount: job.attempt_count + 1,
        lastError: null
      });
      return;
    }

    const failureText =
      snapshot.errorText ??
      `OpenAI background response ended with status "${snapshot.status ?? 'unknown'}" without output.`;

    finalizeRunFromBackgroundResult({
      runId: payload.runId,
      sessionId: payload.sessionId,
      providerId: payload.providerId,
      text: buildFailureAssistantText(failureText),
      errorText: failureText
    });
    markJobFailed(job.id, payload, job.attempt_count + 1, failureText);
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message : 'Failed to poll OpenAI background response.';
    updateBackgroundJob({
      id: job.id,
      state: 'running',
      payload: {
        ...payload,
        updatedAt: Date.now()
      },
      attemptCount: job.attempt_count + 1,
      lastError: message
    });
  }
};

export const processActiveOpenAIBackgroundJobs = async (): Promise<void> => {
  const jobs = listBackgroundJobs({
    kind: getOpenAIBackgroundJobKind(),
    states: ['pending', 'running'],
    limit: 25
  });

  for (const job of jobs) {
    try {
      await processOpenAIBackgroundJob({
        id: job.id,
        payload: job.payload,
        attempt_count: job.attempt_count
      });
    } catch (error) {
      logger.warn('Failed to process OpenAI background job', {
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
