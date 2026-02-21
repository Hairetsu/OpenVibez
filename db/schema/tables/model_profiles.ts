import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { providers } from './providers';

export const modelProfiles = sqliteTable(
  'model_profiles',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    label: text('label').notNull(),
    temperature: real('temperature'),
    topP: real('top_p'),
    maxOutputTokens: integer('max_output_tokens'),
    isDefault: integer('is_default').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_model_profiles_provider').on(table.providerId),
    uniqueIndex('uidx_model_profiles_provider_model').on(table.providerId, table.modelId)
  ]
);
