import { bigint, index, pgTable, varchar } from 'drizzle-orm/pg-core';

import { actors } from './actors.ts';
import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

/**
 * One row per canonical write, used to finish or abandon a write that was
 * interrupted between Git and PostgreSQL (ARCHITECTURE.md section 4).
 *
 * The request context columns are not decoration. Recovery rebuilds a ledger
 * event for an operation that reached Git but not PostgreSQL, and rule 3
 * requires an event to record the request, the session, the client and the
 * model alongside the actor. The Git trailers carry the workspace, the actor,
 * the agent, the proposal and the changes; they do not carry the rest, so a
 * recovered event would otherwise record less than an ordinary one.
 */
export const operations = pgTable(
  'operations',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorId: id('actor_id')
      .notNull()
      .references(() => actors.id),
    operationType: varchar('operation_type', { length: 32 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    objectIds: json('object_ids').notNull(),
    intendedPayloadHash: varchar('intended_payload_hash', { length: 80 }),
    gitCommitHash: varchar('git_commit_hash', { length: 64 }),
    // A number, so an integrity check can order and join it against
    // taxonomy_versions.version.
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' }),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    sessionId: varchar('session_id', { length: 128 }),
    agentId: id('agent_id'),
    client: varchar('client', { length: 64 }),
    provider: varchar('provider', { length: 64 }),
    model: varchar('model', { length: 128 }),
    error: json('error'),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
  },
  (t) => [
    // The recovery scan reads unfinished operations of one workspace.
    index('operations_workspace_state_idx').on(t.workspaceId, t.state),
  ],
);
