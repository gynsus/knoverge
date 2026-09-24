import { customType, index, integer, pgTable, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';
import { searchChunks } from './search.ts';
import { workspaces } from './workspaces.ts';

/**
 * pgvector's type, with no dimension.
 *
 * A dimension fixed in the DDL is what an index over vectors needs, and it
 * would refuse every model that does not have it. Exact search needs no index
 * and is right at the size one self-hosted workspace reaches; when a workspace
 * outgrows it, the index and its fixed dimension are a migration (ADR 0020).
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

/** What produced a set of vectors. Exactly one is active per workspace. */
export const embeddingProfiles = pgTable(
  'embedding_profiles',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    /** Read from the model's own answer, never configured. */
    dimensions: integer('dimensions').notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    createdAt: timestampTz('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('embedding_profiles_model_idx').on(
      table.workspaceId,
      table.provider,
      table.model,
      table.dimensions,
    ),
  ],
);

/** One vector for one chunk under one profile. */
export const embeddings = pgTable(
  'embeddings',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    profileId: id('profile_id')
      .notNull()
      .references(() => embeddingProfiles.id, { onDelete: 'cascade' }),
    /** Goes with the chunk: a vector for text that no longer exists is worse than none. */
    chunkId: id('chunk_id')
      .notNull()
      .references(() => searchChunks.id, { onDelete: 'cascade' }),
    vector: vector('vector').notNull(),
    createdAt: timestampTz('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('embeddings_profile_chunk_idx').on(table.profileId, table.chunkId),
    index('embeddings_workspace_idx').on(table.workspaceId),
  ],
);
