import { pgTable, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';

/**
 * A provider the product can talk to.
 *
 * Instance-level, with no workspace column: one Ollama server is not a property
 * of a workspace (ADR 0021).
 */
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: id('id').primaryKey(),
    kind: varchar('kind', { length: 32 }).notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    baseUrl: varchar('base_url', { length: 512 }).notNull(),
    /** `environment` when a first start read the variables, else `interface`. */
    origin: varchar('origin', { length: 16 }).notNull(),
    lastCheckedAt: timestampTz('last_checked_at'),
    /** One line, never a body: this is somebody else's server. */
    lastError: varchar('last_error', { length: 500 }),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
  },
  (table) => [uniqueIndex('ai_providers_base_url_idx').on(table.baseUrl)],
);

/** Which provider and model answer for a purpose. One answer, not a list. */
export const aiAssignments = pgTable('ai_assignments', {
  purpose: varchar('purpose', { length: 32 }).primaryKey(),
  providerId: id('provider_id')
    .notNull()
    .references(() => aiProviders.id, { onDelete: 'cascade' }),
  model: varchar('model', { length: 200 }).notNull(),
  updatedAt: timestampTz('updated_at').notNull(),
});
