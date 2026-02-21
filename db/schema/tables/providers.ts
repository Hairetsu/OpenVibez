import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['openai', 'anthropic', 'local'] }).notNull(),
    displayName: text('display_name').notNull(),
    authKind: text('auth_kind', { enum: ['api_key', 'oauth_subscription'] }).notNull(),
    keychainRef: text('keychain_ref'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastUsedAt: integer('last_used_at')
  },
  (table) => [index('idx_providers_type').on(table.type), index('idx_providers_active').on(table.isActive)]
);
