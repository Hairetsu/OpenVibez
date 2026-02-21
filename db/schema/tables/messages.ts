import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions';

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    contentFormat: text('content_format').notNull().default('markdown'),
    toolName: text('tool_name'),
    toolCallId: text('tool_call_id'),
    seq: integer('seq').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costMicrounits: integer('cost_microunits'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    uniqueIndex('uidx_messages_session_seq').on(table.sessionId, table.seq),
    index('idx_messages_session_created').on(table.sessionId, table.createdAt)
  ]
);
