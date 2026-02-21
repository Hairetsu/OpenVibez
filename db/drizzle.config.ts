import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema/index.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.OPENVIBEZ_DB_PATH ?? './openvibez.db'
  },
  verbose: true,
  strict: true
});
