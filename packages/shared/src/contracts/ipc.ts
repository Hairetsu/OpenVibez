import { z } from 'zod';

export const providerTypeSchema = z.enum(['openai', 'anthropic', 'local']);

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
  content: z.string().min(1)
});

export const cancelMessageSchema = z.object({
  streamId: z.string().min(1)
});
