import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url:
      process.env['KNOVERGE_DATABASE_URL'] ??
      'postgres://knoverge:knoverge@localhost:5432/knoverge',
  },
  strict: true,
  verbose: true,
});
