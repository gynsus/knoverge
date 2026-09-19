import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

export const categories = pgTable(
  'categories',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    parentId: id('parent_id'),
    slug: varchar('slug', { length: 64 }).notNull(),
    /** Materialised chain of slugs, for example projects/pixel-brisbane/architecture. */
    path: varchar('path', { length: 1024 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    inclusionGuidance: jsonb('inclusion_guidance')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    exclusionGuidance: jsonb('exclusion_guidance')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    mergedIntoCategoryId: id('merged_into_category_id'),
    createdByActorId: id('created_by_actor_id').notNull(),
    approvedByActorId: id('approved_by_actor_id'),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('categories_workspace_path_idx').on(t.workspaceId, t.path),
    index('categories_workspace_parent_idx').on(t.workspaceId, t.parentId),
  ],
);

export const categoryAliases = pgTable(
  'category_aliases',
  {
    id: id('id').primaryKey(),
    categoryId: id('category_id')
      .notNull()
      .references(() => categories.id),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    alias: varchar('alias', { length: 120 }).notNull(),
    normalisedAlias: varchar('normalised_alias', { length: 120 }).notNull(),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('category_aliases_workspace_alias_idx').on(t.workspaceId, t.normalisedAlias),
    index('category_aliases_category_idx').on(t.categoryId),
  ],
);

/**
 * One row per taxonomy mutation. The current version of a workspace is the
 * highest row; git_commit_hash is filled once the workspace repository exists.
 */
export const taxonomyVersions = pgTable(
  'taxonomy_versions',
  {
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    version: bigint('version', { mode: 'number' }).notNull(),
    gitCommitHash: varchar('git_commit_hash', { length: 64 }),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [uniqueIndex('taxonomy_versions_workspace_version_idx').on(t.workspaceId, t.version)],
);
