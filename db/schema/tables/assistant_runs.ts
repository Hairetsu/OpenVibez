import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { messages } from './messages';
import { sessions } from './sessions';

export const assistantRuns = sqliteTable(
  'assistant_runs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    clientRequestId: text('client_request_id').notNull(),
    streamId: text('stream_id').notNull(),
    status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
    userMessageId: text('user_message_id').references(() => messages.id, { onDelete: 'set null' }),
    assistantMessageId: text('assistant_message_id').references(() => messages.id, { onDelete: 'set null' }),
    errorText: text('error_text'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('uidx_assistant_runs_session_request').on(table.sessionId, table.clientRequestId),
    index('idx_assistant_runs_session_created').on(table.sessionId, table.createdAt)
  ]
);
