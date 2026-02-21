import { z } from 'zod';

export const providerTypeSchema = z.enum(['openai', 'anthropic', 'local']);

export const providerCreateSchema = z.object({
  type: providerTypeSchema,
  displayName: z.string().min(1),
  authKind: z.enum(['api_key', 'oauth_subscription'])
});

export const providerSecretSchema = z.object({
  providerId: z.string().min(1),
  secret: z.string().min(1)
});

export const providerIdSchema = z.object({
  providerId: z.string().min(1)
});

export const providerSubscriptionStartSchema = z.object({
  providerId: z.string().min(1)
});

export const providerModelsSchema = z.object({
  providerId: z.string().min(1)
});

export const sessionCreateSchema = z.object({
  title: z.string().min(1),
  providerId: z.string().min(1),
  workspaceId: z.string().optional(),
  modelProfileId: z.string().optional()
});

export const sessionArchiveSchema = z.object({
  sessionId: z.string().min(1)
});

export const messageSendSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  streamId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  accessMode: z.enum(['scoped', 'root']).optional(),
  workspaceId: z.string().min(1).optional()
});

export const messageListSchema = z.object({
  sessionId: z.string().min(1)
});

export const workspaceAddSchema = z.object({
  path: z.string().min(1),
  trustLevel: z.enum(['trusted', 'read_only', 'untrusted']).default('trusted')
});

export const settingsGetSchema = z.object({
  key: z.string().min(1)
});

export const settingsSetSchema = z.object({
  key: z.string().min(1),
  value: z.unknown()
});

export const usageSummarySchema = z.object({
  days: z.number().int().min(1).max(365).default(30)
});

export const openExternalSchema = z.object({
  url: z.string().url()
});
