import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { actors } from './actors.ts';
import { categories } from './categories.ts';
import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

/**
 * The current state of one item. The file in Git is canonical; this is the
 * queryable index of it, and every column here is derived from a revision.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 64 }).notNull(),
    /** Derived: knowledge/<primary category path>/<slug>.md */
    markdownPath: varchar('markdown_path', { length: 1024 }).notNull(),
    type: varchar('type', { length: 24 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    language: varchar('language', { length: 8 }).notNull(),
    currentRevisionId: id('current_revision_id'),
    reviewState: varchar('review_state', { length: 20 }).notNull().default('unreviewed'),
    evidenceState: varchar('evidence_state', { length: 20 }).notNull().default('none'),
    disputed: boolean('disputed').notNull().default(false),
    validFrom: timestampTz('valid_from'),
    validUntil: timestampTz('valid_until'),
    observedAt: timestampTz('observed_at'),
    sourceSystem: varchar('source_system', { length: 64 }),
    externalKey: varchar('external_key', { length: 512 }),
    createdByActorId: id('created_by_actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
    deletedAt: timestampTz('deleted_at'),
  },
  (t) => [
    uniqueIndex('knowledge_items_path_idx').on(t.workspaceId, t.markdownPath),
    index('knowledge_items_workspace_idx').on(t.workspaceId, t.status),
  ],
);

/**
 * One row per commit that touched the item. Immutable, enforced by a trigger:
 * a revision records that a commit was made, and a record that can be edited
 * afterwards records nothing.
 */
export const knowledgeRevisions = pgTable(
  'knowledge_revisions',
  {
    id: id('id').primaryKey(),
    knowledgeItemId: id('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    workspaceId: id('workspace_id').notNull(),
    revisionNumber: bigint('revision_number', { mode: 'number' }).notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    frontmatterHash: varchar('frontmatter_hash', { length: 80 }).notNull(),
    gitCommitHash: varchar('git_commit_hash', { length: 64 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    markdownPath: varchar('markdown_path', { length: 1024 }).notNull(),
    frontmatter: json('frontmatter').notNull(),
    changeKind: varchar('change_kind', { length: 20 }).notNull(),
    createdByActorId: id('created_by_actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
    operationId: id('operation_id').notNull(),
    /** Why, in whoever's own words. Null for a revision nobody explained. */
    reason: varchar('reason', { length: 500 }),
  },
  (t) => [
    uniqueIndex('knowledge_revisions_number_idx').on(t.knowledgeItemId, t.revisionNumber),
    index('knowledge_revisions_item_idx').on(t.knowledgeItemId, t.createdAt),
    index('knowledge_revisions_commit_idx').on(t.workspaceId, t.gitCommitHash),
  ],
);

/** Which categories an item is in. Exactly one is primary, by partial index. */
export const knowledgeItemCategories = pgTable(
  'knowledge_item_categories',
  {
    knowledgeItemId: id('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    categoryId: id('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'knowledge_item_categories_pk',
      columns: [t.knowledgeItemId, t.categoryId],
    }),
    index('knowledge_item_categories_category_idx').on(t.categoryId),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    normalisedName: varchar('normalised_name', { length: 64 }).notNull(),
  },
  (t) => [uniqueIndex('tags_normalised_idx').on(t.workspaceId, t.normalisedName)],
);

export const knowledgeItemTags = pgTable(
  'knowledge_item_tags',
  {
    knowledgeItemId: id('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    tagId: id('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ name: 'knowledge_item_tags_pk', columns: [t.knowledgeItemId, t.tagId] })],
);

export const knowledgeItemRelations = relations(knowledgeItems, ({ many }) => ({
  revisions: many(knowledgeRevisions),
  categories: many(knowledgeItemCategories),
  tags: many(knowledgeItemTags),
}));

/**
 * A source the knowledge came from. Deduplicated per workspace by whatever
 * identifies it — a URI, an external record — so citing the same page twice is
 * one row and the graph of what rests on what stays readable.
 */
export const sourceReferences = pgTable(
  'source_references',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceType: varchar('source_type', { length: 32 }).notNull(),
    uri: varchar('uri', { length: 2048 }),
    externalSystem: varchar('external_system', { length: 64 }),
    externalKey: varchar('external_key', { length: 512 }),
    attachmentId: id('attachment_id'),
    sourceModifiedAt: timestampTz('source_modified_at'),
    /** The raw source's fingerprint, not the knowledge content hash. */
    sourceContentHash: varchar('source_content_hash', { length: 80 }),
    confidence: real('confidence'),
    metadata: json('metadata').notNull().default({}),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [index('source_references_workspace_idx').on(t.workspaceId, t.sourceType)],
);

/** Which sources a revision rested on, and in what role. */
export const revisionSources = pgTable(
  'revision_sources',
  {
    revisionId: id('revision_id')
      .notNull()
      .references(() => knowledgeRevisions.id, { onDelete: 'cascade' }),
    sourceReferenceId: id('source_reference_id')
      .notNull()
      .references(() => sourceReferences.id, { onDelete: 'cascade' }),
    evidenceRole: varchar('evidence_role', { length: 16 }).notNull().default('primary'),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ name: 'revision_sources_pk', columns: [t.revisionId, t.sourceReferenceId] }),
  ],
);

/**
 * How one item connects to another. Removal is logical: a relation that was
 * once true is part of the history of both items.
 */
export const knowledgeRelations = pgTable(
  'knowledge_relations',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromItemId: id('from_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    relationType: varchar('relation_type', { length: 24 }).notNull(),
    toItemId: id('to_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    validFrom: timestampTz('valid_from'),
    validUntil: timestampTz('valid_until'),
    createdByActorId: id('created_by_actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
    removedAt: timestampTz('removed_at'),
  },
  (t) => [index('knowledge_relations_to_idx').on(t.toItemId, t.relationType)],
);
