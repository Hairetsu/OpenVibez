import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { messages } from './messages';
import { providers } from './providers';
import { sessions } from './sessions';

export const usageEvents = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    eventType: text('event_type', { enum: ['completion', 'embedding', 'tool'] }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costMicrounits: integer('cost_microunits').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_usage_provider_created').on(table.providerId, table.createdAt),
    index('idx_usage_session_created').on(table.sessionId, table.createdAt)
  ]
);
