import { pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { id, json, timestampTz } from './common.ts';

export const workspaces = pgTable('workspaces', {
  id: id('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  defaultLanguage: varchar('default_language', { length: 8 }).notNull().default('en'),
  settings: json('settings').notNull().default({}),
  createdAt: timestampTz('created_at').notNull(),
  updatedAt: timestampTz('updated_at').notNull(),
  /** Set while the workspace is kept but accepts no changes. Reversible. */
  archivedAt: timestampTz('archived_at'),
});
