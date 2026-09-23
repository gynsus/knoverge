import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { agents } from './agents.ts';
import { id, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

/**
 * Where one agent's reconciliation of one source got to.
 *
 * Kept per source rather than per agent: the same agent may carry knowledge
 * from several places — one repository, an export, a notes directory — and
 * each of them moves at its own pace. A single checkpoint for all of them
 * would make a full rescan the only safe answer whenever any one changed.
 */
export const agentSyncState = pgTable(
  'agent_sync_state',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: id('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sourceSystem: varchar('source_system', { length: 64 }).notNull(),
    sourceNamespace: varchar('source_namespace', { length: 512 }),
    lastCompletedSyncId: id('last_completed_sync_id'),
    lastChangeSequence: integer('last_change_sequence'),
    lastTaxonomyVersion: integer('last_taxonomy_version'),
    lastCompletedAt: timestampTz('last_completed_at'),
  },
  (t) => [
    // Coalesced, because two nulls are not equal to PostgreSQL and a source
    // with no namespace is one source rather than a new one on every sync.
    // Without this an agent accumulates a checkpoint per run and never finds
    // the previous one.
    uniqueIndex('agent_sync_state_source_idx').on(
      t.workspaceId,
      t.agentId,
      t.sourceSystem,
      sql`coalesce(${t.sourceNamespace}, '')`,
    ),
  ],
);

/** One reconciliation pass, from the first candidate to the checkpoint. */
export const syncSessions = pgTable(
  'sync_sessions',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: id('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sourceSystem: varchar('source_system', { length: 64 }).notNull(),
    sourceNamespace: varchar('source_namespace', { length: 512 }),
    state: varchar('state', { length: 24 }).notNull().default('open'),
    /** What the taxonomy was when the agent started, so a later change is visible. */
    taxonomyVersion: integer('taxonomy_version').notNull(),
    /** The ledger position to resume the change feed from once this completes. */
    changeSequenceAtStart: integer('change_sequence_at_start').notNull(),
    createdAt: timestampTz('created_at').notNull(),
    expiresAt: timestampTz('expires_at').notNull(),
    completedAt: timestampTz('completed_at'),
    stats: jsonb('stats_json').$type<Record<string, number>>().notNull().default({}),
  },
  (t) => [index('sync_sessions_workspace_idx').on(t.workspaceId, t.agentId, t.createdAt)],
);

/**
 * One thing an agent believes it knows, and what the workspace made of it.
 *
 * Holds an abstract and never the material itself: matching needs enough to
 * recognise knowledge, and sending the whole of it is the context cost the
 * protocol exists to avoid.
 */
export const syncCandidates = pgTable(
  'sync_candidates',
  {
    id: id('id').primaryKey(),
    syncSessionId: id('sync_session_id')
      .notNull()
      .references(() => syncSessions.id, { onDelete: 'cascade' }),
    /** The agent's own identifier, and the idempotency key inside the session. */
    clientCandidateId: varchar('client_candidate_id', { length: 200 }).notNull(),
    externalKey: varchar('external_key', { length: 512 }),
    /** Fingerprint of the agent's raw source: did my source change? */
    sourceContentHash: varchar('source_content_hash', { length: 80 }),
    /** Knoverge-normalised hash: does the workspace already hold this text? */
    candidateContentHash: varchar('candidate_content_hash', { length: 80 }),
    sourceModifiedAt: timestampTz('source_modified_at'),
    title: text('title').notNull(),
    knowledgeType: varchar('knowledge_type', { length: 32 }).notNull(),
    language: varchar('language', { length: 8 }),
    proposedCategoryPaths: jsonb('proposed_category_paths_json')
      .$type<string[]>()
      .notNull()
      .default([]),
    abstract: text('abstract'),
    classification: varchar('classification', { length: 24 }).notNull(),
    /** `final` when nothing later can change it; `provisional` until refined. */
    classificationState: varchar('classification_state', { length: 16 }).notNull(),
    matchReason: varchar('match_reason', { length: 24 }).notNull(),
    matchedItemIds: jsonb('matched_item_ids_json').$type<string[]>().notNull().default([]),
    /** Why the server decided this, in terms an agent can act on. */
    serverReason: jsonb('server_reason_json').$type<Record<string, unknown>>(),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('sync_candidates_client_id_idx').on(t.syncSessionId, t.clientCandidateId),
    // Paging a session's candidates, and finding the ones a job still owes an
    // answer for.
    index('sync_candidates_state_idx').on(t.syncSessionId, t.classificationState, t.id),
  ],
);
