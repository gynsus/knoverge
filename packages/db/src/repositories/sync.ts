import type { AgentId, WorkspaceId } from '@knoverge/contracts';
import type {
  AgentSyncStateRecord,
  SyncCandidateRecord,
  SyncRepository,
  SyncSessionRecord,
  Tx,
} from '@knoverge/core';
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { agentSyncState, syncCandidates, syncSessions } from '../schema/sync.ts';
import { asTx } from '../unit-of-work.ts';

function toSession(row: typeof syncSessions.$inferSelect): SyncSessionRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    agentId: row.agentId as AgentId,
    state: row.state as SyncSessionRecord['state'],
  };
}

function toCandidate(row: typeof syncCandidates.$inferSelect): SyncCandidateRecord {
  return {
    ...row,
    classification: row.classification as SyncCandidateRecord['classification'],
    classificationState: row.classificationState as SyncCandidateRecord['classificationState'],
    matchReason: row.matchReason as SyncCandidateRecord['matchReason'],
  };
}

export function createSyncRepository(db: Database): SyncRepository {
  return {
    async insertSession(tx: Tx, session: SyncSessionRecord) {
      await asTx(tx).insert(syncSessions).values(session);
    },
    async findSession(workspaceId: WorkspaceId, id: string) {
      const rows = await db
        .select()
        .from(syncSessions)
        .where(and(eq(syncSessions.workspaceId, workspaceId), eq(syncSessions.id, id)))
        .limit(1);
      return rows[0] ? toSession(rows[0]) : null;
    },
    async updateSession(tx: Tx, id: string, patch) {
      await asTx(tx).update(syncSessions).set(patch).where(eq(syncSessions.id, id));
    },

    async upsertCandidates(tx: Tx, candidates) {
      if (candidates.length === 0) return;
      // A resubmitted batch is the same batch: the key inside a session is
      // the client's own candidate id, so a retry after a dropped response
      // replaces what it said rather than saying it twice.
      await asTx(tx)
        .insert(syncCandidates)
        .values([...candidates])
        .onConflictDoUpdate({
          target: [syncCandidates.syncSessionId, syncCandidates.clientCandidateId],
          set: {
            externalKey: sql`excluded.external_key`,
            sourceContentHash: sql`excluded.source_content_hash`,
            candidateContentHash: sql`excluded.candidate_content_hash`,
            sourceModifiedAt: sql`excluded.source_modified_at`,
            title: sql`excluded.title`,
            knowledgeType: sql`excluded.knowledge_type`,
            language: sql`excluded.language`,
            proposedCategoryPaths: sql`excluded.proposed_category_paths_json`,
            abstract: sql`excluded.abstract`,
            classification: sql`excluded.classification`,
            classificationState: sql`excluded.classification_state`,
            matchReason: sql`excluded.match_reason`,
            matchedItemIds: sql`excluded.matched_item_ids_json`,
            serverReason: sql`excluded.server_reason_json`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    },
    async listCandidates(syncSessionId, options) {
      const rows = await db
        .select()
        .from(syncCandidates)
        .where(
          and(
            eq(syncCandidates.syncSessionId, syncSessionId),
            ...(options.onlyFinal ? [eq(syncCandidates.classificationState, 'final')] : []),
            ...(options.onlyProvisional
              ? [eq(syncCandidates.classificationState, 'provisional')]
              : []),
            ...(options.after ? [gt(syncCandidates.id, options.after)] : []),
          ),
        )
        // By id, which sorts in creation order, so a cursor over it neither
        // repeats nor skips.
        .orderBy(asc(syncCandidates.id))
        .limit(options.limit);
      return rows.map(toCandidate);
    },
    async countCandidates(syncSessionId) {
      const rows = await db
        .select({
          classification: syncCandidates.classification,
          state: syncCandidates.classificationState,
          total: sql<number>`count(*)::int`,
        })
        .from(syncCandidates)
        .where(eq(syncCandidates.syncSessionId, syncSessionId))
        .groupBy(syncCandidates.classification, syncCandidates.classificationState);

      const byClassification: Record<string, number> = {};
      let pending = 0;
      let total = 0;
      for (const row of rows) {
        byClassification[row.classification] =
          (byClassification[row.classification] ?? 0) + row.total;
        if (row.state === 'provisional') pending += row.total;
        total += row.total;
      }
      return { byClassification, pending, total };
    },

    async previousCandidates(workspaceId, agentId, source, externalKeys) {
      const found = new Map<string, SyncCandidateRecord>();
      if (externalKeys.length === 0) return found;
      const rows = await db
        .select({ candidate: syncCandidates, completedAt: syncSessions.completedAt })
        .from(syncCandidates)
        .innerJoin(syncSessions, eq(syncSessions.id, syncCandidates.syncSessionId))
        .where(
          and(
            eq(syncSessions.workspaceId, workspaceId),
            eq(syncSessions.agentId, agentId),
            eq(syncSessions.sourceSystem, source.system),
            sql`coalesce(${syncSessions.sourceNamespace}, '') = coalesce(${source.namespace}, '')`,
            // Only a finished pass. An abandoned one recorded an intention.
            eq(syncSessions.state, 'completed'),
            isNotNull(syncCandidates.externalKey),
            inArray(syncCandidates.externalKey, [...externalKeys]),
          ),
        )
        // Newest first, so the first row seen for a key is the last thing
        // this agent said about it.
        .orderBy(desc(syncSessions.completedAt));
      for (const row of rows) {
        const key = row.candidate.externalKey;
        if (key && !found.has(key)) found.set(key, toCandidate(row.candidate));
      }
      return found;
    },

    async findState(workspaceId, agentId, source) {
      const rows = await db
        .select()
        .from(agentSyncState)
        .where(
          and(
            eq(agentSyncState.workspaceId, workspaceId),
            eq(agentSyncState.agentId, agentId),
            eq(agentSyncState.sourceSystem, source.system),
            sql`coalesce(${agentSyncState.sourceNamespace}, '') = coalesce(${source.namespace}, '')`,
          ),
        )
        .limit(1);
      const row = rows[0];
      return row
        ? { ...row, workspaceId: row.workspaceId as WorkspaceId, agentId: row.agentId as AgentId }
        : null;
    },
    async upsertState(tx: Tx, state: AgentSyncStateRecord) {
      // Raw, because the conflict target is an expression — the coalesced
      // namespace the unique index is built on — and the query builder only
      // names columns. Written out rather than worked around with a read and
      // a write, which two passes finishing at once would race.
      await asTx(tx).execute(sql`
        insert into ${agentSyncState} (
          "id", "workspace_id", "agent_id", "source_system", "source_namespace",
          "last_completed_sync_id", "last_change_sequence", "last_taxonomy_version",
          "last_completed_at"
        ) values (
          ${state.id}, ${state.workspaceId}, ${state.agentId}, ${state.sourceSystem},
          ${state.sourceNamespace}, ${state.lastCompletedSyncId}, ${state.lastChangeSequence},
          ${state.lastTaxonomyVersion}, ${state.lastCompletedAt}
        )
        on conflict ("workspace_id", "agent_id", "source_system", coalesce("source_namespace", ''))
        do update set
          "last_completed_sync_id" = excluded."last_completed_sync_id",
          "last_change_sequence" = excluded."last_change_sequence",
          "last_taxonomy_version" = excluded."last_taxonomy_version",
          "last_completed_at" = excluded."last_completed_at"
      `);
    },
  };
}
