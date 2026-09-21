import { index, jsonb, pgTable, real, text, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { actors } from './actors.ts';
import { categories } from './categories.ts';
import { id, timestampTz } from './common.ts';
import { knowledgeItems } from './knowledge.ts';
import { workspaces } from './workspaces.ts';

/**
 * A change somebody asked for.
 *
 * Every write that policy allowed is recorded here, including one it allowed
 * directly: those are stored already approved, resolved by the system actor,
 * so the trail reads the same whether a person looked at it or a rule did. A
 * denial never becomes a proposal — there was nothing to decide.
 *
 * `proposedPayload` is the only place outside Git where proposed knowledge
 * text lives, which is why purge redacts it.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    proposalType: varchar('proposal_type', { length: 32 }).notNull(),
    targetItemId: id('target_item_id').references(() => knowledgeItems.id, {
      onDelete: 'cascade',
    }),
    targetCategoryId: id('target_category_id').references(() => categories.id, {
      onDelete: 'cascade',
    }),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    proposedByActorId: id('proposed_by_actor_id')
      .notNull()
      .references(() => actors.id),
    baseRevisionId: id('base_revision_id'),
    baseContentHash: varchar('base_content_hash', { length: 80 }),
    proposedPayload: jsonb('proposed_payload').notNull(),
    reason: text('reason'),
    confidence: real('confidence'),
    acknowledgedDuplicateIds: jsonb('acknowledged_duplicate_ids')
      .notNull()
      .default(sql`'[]'::jsonb`),
    syncSessionId: id('sync_session_id'),
    policyDecision: varchar('policy_decision', { length: 16 }).notNull(),
    policyRuleId: id('policy_rule_id'),
    createdAt: timestampTz('created_at').notNull(),
    resolvedAt: timestampTz('resolved_at'),
    resolvedByActorId: id('resolved_by_actor_id').references(() => actors.id),
    resolutionNote: text('resolution_note'),
    resultRevisionIds: jsonb('result_revision_ids')
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [
    index('proposals_workspace_idx').on(t.workspaceId, t.status, t.createdAt),
    index('proposals_proposer_idx').on(t.proposedByActorId, t.createdAt),
  ],
);
