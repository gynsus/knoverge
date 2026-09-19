import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

/**
 * Append-only, keyed hash-chained event ledger (ADR 0007). UPDATE and DELETE are
 * rejected by a database trigger created in the migration.
 */
export const events = pgTable(
  'events',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    /** Which field set event_hash covers, so old rows keep verifying. */
    hashVersion: integer('hash_version').notNull().default(1),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    actorId: id('actor_id').notNull(),
    agentId: id('agent_id'),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    sessionId: varchar('session_id', { length: 128 }),
    client: varchar('client', { length: 64 }),
    provider: varchar('provider', { length: 64 }),
    model: varchar('model', { length: 128 }),
    objectType: varchar('object_type', { length: 32 }).notNull(),
    objectId: varchar('object_id', { length: 128 }).notNull(),
    beforeRevisionId: id('before_revision_id'),
    beforeContentHash: varchar('before_content_hash', { length: 80 }),
    afterRevisionId: id('after_revision_id'),
    afterContentHash: varchar('after_content_hash', { length: 80 }),
    proposalId: id('proposal_id'),
    sourceReferenceId: id('source_reference_id'),
    categoryIds: jsonb('category_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: json('metadata').notNull().default({}),
    prevEventHash: text('prev_event_hash').notNull(),
    eventHash: text('event_hash').notNull(),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('events_workspace_sequence_idx').on(t.workspaceId, t.sequence),
    index('events_workspace_object_idx').on(t.workspaceId, t.objectType, t.objectId),
    index('events_workspace_type_idx').on(t.workspaceId, t.eventType),
  ],
);
