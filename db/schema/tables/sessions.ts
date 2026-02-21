import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { modelProfiles } from './model_profiles';
import { providers } from './providers';
import { workspaceProjects } from './workspace_projects';

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaceProjects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    modelProfileId: text('model_profile_id').references(() => modelProfiles.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['active', 'archived', 'error'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMessageAt: integer('last_message_at')
  },
  (table) => [
    index('idx_sessions_workspace').on(table.workspaceId),
    index('idx_sessions_last_message_at').on(table.lastMessageAt),
    index('idx_sessions_status').on(table.status)
  ]
);
