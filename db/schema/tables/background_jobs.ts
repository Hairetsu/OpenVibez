import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const backgroundJobs = sqliteTable(
  'background_jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['workspace_index', 'sync', 'cleanup'] }).notNull(),
    state: text('state', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
    payloadJson: text('payload_json').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_jobs_state_kind').on(table.state, table.kind)]
);
