import { z } from 'zod';

export const providerTypeSchema = z.enum(['openai', 'anthropic', 'gemini', 'openrouter', 'grok', 'local']);

export const createProviderSchema = z.object({
  type: providerTypeSchema,
  displayName: z.string().min(1),
  authKind: z.enum(['api_key', 'oauth_subscription'])
});

export const saveProviderSecretSchema = z.object({
  providerId: z.string().min(1),
  secret: z.string()
});

export const createSessionSchema = z.object({
  title: z.string().min(1),
  providerId: z.string().min(1),
  workspaceId: z.string().optional(),
  modelProfileId: z.string().optional()
});

export const setSessionProviderSchema = z.object({
  sessionId: z.string().min(1),
  providerId: z.string().min(1)
});

export const sendMessageSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  streamId: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  accessMode: z.enum(['scoped', 'root']).optional(),
  workspaceId: z.string().min(1).optional()
});

export const cancelMessageSchema = z.object({
  streamId: z.string().min(1)
});
