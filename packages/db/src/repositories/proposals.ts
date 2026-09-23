import type {
  ActorId,
  CategoryId,
  KnowledgeItemId,
  ProposalId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';
import type {
  ListProposalsOptions,
  ProposalPatch,
  ProposalRecord,
  ProposalRepository,
  Tx,
} from '@knoverge/core';
import { and, asc, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { proposals } from '../schema/proposals.ts';
import { asTx } from '../unit-of-work.ts';

function toProposal(row: typeof proposals.$inferSelect): ProposalRecord {
  return {
    ...row,
    id: row.id as ProposalId,
    workspaceId: row.workspaceId as WorkspaceId,
    targetItemId: row.targetItemId as KnowledgeItemId | null,
    targetCategoryId: row.targetCategoryId as CategoryId | null,
    proposedByActorId: row.proposedByActorId as ActorId,
    resolvedByActorId: row.resolvedByActorId as ActorId | null,
    baseRevisionId: row.baseRevisionId as RevisionId | null,
    proposalType: row.proposalType as ProposalRecord['proposalType'],
    status: row.status as ProposalRecord['status'],
    policyDecision: row.policyDecision as ProposalRecord['policyDecision'],
    proposedPayload: row.proposedPayload as Record<string, unknown>,
    acknowledgedDuplicateIds: row.acknowledgedDuplicateIds as string[],
    resultRevisionIds: row.resultRevisionIds as RevisionId[],
  };
}

export function createProposalRepository(db: Database): ProposalRepository {
  return {
    async insert(tx: Tx, proposal: ProposalRecord) {
      await asTx(tx).insert(proposals).values(proposal);
    },
    async update(tx: Tx, workspaceId: WorkspaceId, id: ProposalId, patch: ProposalPatch) {
      await asTx(tx)
        .update(proposals)
        .set(patch as Partial<typeof proposals.$inferInsert>)
        .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.id, id)));
    },
    async findById(workspaceId: WorkspaceId, id: ProposalId, tx?: Tx) {
      const rows = await (tx ? asTx(tx) : db)
        .select()
        .from(proposals)
        .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.id, id)))
        .limit(1);
      return rows[0] ? toProposal(rows[0]) : null;
    },
    async list(workspaceId: WorkspaceId, options: ListProposalsOptions = {}) {
      const where = [eq(proposals.workspaceId, workspaceId)];
      if (options.status) where.push(eq(proposals.status, options.status));
      if (options.proposedByActorId)
        where.push(eq(proposals.proposedByActorId, options.proposedByActorId));
      if (options.targetItemId) where.push(eq(proposals.targetItemId, options.targetItemId));
      if (options.syncSessionId)
        where.push(eq(proposals.syncSessionId, options.syncSessionId));
      const rows = await db
        .select()
        .from(proposals)
        .where(and(...where))
        // Oldest first: a review inbox is a queue, and the thing that has been
        // waiting longest is the thing to look at.
        .orderBy(asc(proposals.createdAt))
        .limit(Math.min(options.limit ?? 50, 200));
      return rows.map(toProposal);
    },
    async redactResolvedBefore(tx: Tx, before: Date) {
      const rows = await asTx(tx)
        .update(proposals)
        .set({ proposedPayload: {} })
        .where(
          and(
            ne(proposals.status, 'pending'),
            isNotNull(proposals.resolvedAt),
            lt(proposals.resolvedAt, before),
            // Already empty rows would otherwise be rewritten at every run.
            sql`${proposals.proposedPayload} <> '{}'::jsonb`,
          ),
        )
        .returning({ id: proposals.id });
      return rows.length;
    },
  };
}
