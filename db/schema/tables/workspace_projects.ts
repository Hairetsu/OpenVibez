import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workspaceProjects = sqliteTable('workspace_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  trustLevel: text('trust_level', { enum: ['trusted', 'read_only', 'untrusted'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastOpenedAt: integer('last_opened_at')
});
