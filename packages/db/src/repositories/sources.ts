import type {
  ActorId,
  EvidenceRole,
  KnowledgeItemId,
  RelationId,
  RelationType,
  SourceReferenceId,
  SourceType,
  WorkspaceId,
} from '@knoverge/contracts';
import type {
  RelationRecord,
  RelationRepository,
  RevisionSourceRecord,
  SourceRecord,
  SourceRepository,
  Tx,
} from '@knoverge/core';
import { newId } from '@knoverge/core';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { knowledgeRelations, revisionSources, sourceReferences } from '../schema/knowledge.ts';
import { asTx } from '../unit-of-work.ts';

type SourceInput = Omit<SourceRecord, 'id' | 'workspaceId' | 'createdAt'>;

function toSource(row: typeof sourceReferences.$inferSelect): SourceRecord {
  return {
    ...row,
    id: row.id as SourceReferenceId,
    workspaceId: row.workspaceId as WorkspaceId,
    sourceType: row.sourceType as SourceType,
    metadata: row.metadata as Record<string, unknown>,
  };
}

function toRelation(row: typeof knowledgeRelations.$inferSelect): RelationRecord {
  return {
    ...row,
    id: row.id as RelationId,
    workspaceId: row.workspaceId as WorkspaceId,
    fromItemId: row.fromItemId as KnowledgeItemId,
    toItemId: row.toItemId as KnowledgeItemId,
    relationType: row.relationType as RelationType,
    createdByActorId: row.createdByActorId as ActorId,
  };
}

export function createSourceRepository(db: Database): SourceRepository {
  return {
    async ensure(tx: Tx, workspaceId: WorkspaceId, sources: readonly SourceInput[], at: Date) {
      const t = asTx(tx);
      const ids: SourceReferenceId[] = [];
      for (const source of sources) {
        // A URI, or a record in another system, identifies a source. One with
        // neither — a person saying something, an agent session — is its own
        // occurrence and is not deduplicated against anything.
        const identity =
          source.uri !== null
            ? eq(sourceReferences.uri, source.uri)
            : source.externalSystem !== null && source.externalKey !== null
              ? and(
                  eq(sourceReferences.externalSystem, source.externalSystem),
                  eq(sourceReferences.externalKey, source.externalKey),
                )
              : null;
        if (identity) {
          const existing = await t
            .select()
            .from(sourceReferences)
            .where(and(eq(sourceReferences.workspaceId, workspaceId), identity))
            .limit(1);
          if (existing[0]) {
            ids.push(existing[0].id as SourceReferenceId);
            continue;
          }
        }
        const id = newId('src') as SourceReferenceId;
        await t.insert(sourceReferences).values({ ...source, id, workspaceId, createdAt: at });
        ids.push(id);
      }
      return ids;
    },
    async attachToRevision(tx: Tx, rows: readonly RevisionSourceRecord[]) {
      if (rows.length === 0) return;
      await asTx(tx)
        .insert(revisionSources)
        .values([...rows]);
    },
    async forRevision(revisionId) {
      const rows = await db
        .select({ source: sourceReferences, role: revisionSources.evidenceRole })
        .from(revisionSources)
        .innerJoin(sourceReferences, eq(sourceReferences.id, revisionSources.sourceReferenceId))
        .where(eq(revisionSources.revisionId, revisionId))
        .orderBy(asc(revisionSources.position));
      return rows.map((row) => ({
        ...toSource(row.source),
        role: row.role as EvidenceRole,
      }));
    },
  };
}

export function createRelationRepository(db: Database): RelationRepository {
  const live = (workspaceId: WorkspaceId) =>
    and(eq(knowledgeRelations.workspaceId, workspaceId), isNull(knowledgeRelations.removedAt));
  return {
    async replaceForItem(tx: Tx, workspaceId, fromItemId, wanted, at) {
      const t = asTx(tx);
      const existing = await t
        .select()
        .from(knowledgeRelations)
        .where(and(live(workspaceId), eq(knowledgeRelations.fromItemId, fromItemId)));
      const key = (type: string, to: string) => `${type}\u0000${to}`;
      const keep = new Set(wanted.map((r) => key(r.relationType, r.toItemId)));

      for (const row of existing) {
        if (keep.has(key(row.relationType, row.toItemId))) continue;
        // Logical: a relation that was once true is part of the history of
        // both items, and a hard delete would lose why they were ever linked.
        await t
          .update(knowledgeRelations)
          .set({ removedAt: at })
          .where(eq(knowledgeRelations.id, row.id));
      }
      const have = new Set(existing.map((row) => key(row.relationType, row.toItemId)));
      for (const relation of wanted) {
        if (have.has(key(relation.relationType, relation.toItemId))) continue;
        await t.insert(knowledgeRelations).values({
          ...relation,
          id: newId('rel'),
          workspaceId,
          fromItemId,
          createdAt: at,
          removedAt: null,
        });
      }
    },
    async listForItem(workspaceId, fromItemId) {
      const rows = await db
        .select()
        .from(knowledgeRelations)
        .where(and(live(workspaceId), eq(knowledgeRelations.fromItemId, fromItemId)))
        .orderBy(asc(knowledgeRelations.createdAt));
      return rows.map(toRelation);
    },
    async listPointingAt(workspaceId, toItemId) {
      const rows = await db
        .select()
        .from(knowledgeRelations)
        .where(and(live(workspaceId), eq(knowledgeRelations.toItemId, toItemId)))
        .orderBy(asc(knowledgeRelations.createdAt));
      return rows.map(toRelation);
    },
  };
}
