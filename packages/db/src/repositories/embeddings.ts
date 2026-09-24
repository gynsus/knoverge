import type { WorkspaceId } from '@knoverge/contracts';
import type {
  EmbeddingProfileRecord,
  EmbeddingProfileStatus,
  EmbeddingRepository,
  PendingChunk,
  Tx,
} from '@knoverge/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { embeddingProfiles, embeddings } from '../schema/embeddings.ts';
import { searchChunks } from '../schema/search.ts';
import { asTx } from '../unit-of-work.ts';

function toProfile(row: typeof embeddingProfiles.$inferSelect): EmbeddingProfileRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    status: row.status as EmbeddingProfileStatus,
  };
}

export function createEmbeddingRepository(db: Database): EmbeddingRepository {
  const byStatus = async (workspaceId: WorkspaceId, status: EmbeddingProfileStatus) => {
    const rows = await db
      .select()
      .from(embeddingProfiles)
      .where(
        and(eq(embeddingProfiles.workspaceId, workspaceId), eq(embeddingProfiles.status, status)),
      )
      .limit(1);
    return rows[0] ? toProfile(rows[0]) : null;
  };

  return {
    active: (workspaceId) => byStatus(workspaceId, 'active'),
    rebuilding: (workspaceId) => byStatus(workspaceId, 'rebuilding'),

    async findProfile(workspaceId, provider, model, dimensions) {
      const rows = await db
        .select()
        .from(embeddingProfiles)
        .where(
          and(
            eq(embeddingProfiles.workspaceId, workspaceId),
            eq(embeddingProfiles.provider, provider),
            eq(embeddingProfiles.model, model),
            eq(embeddingProfiles.dimensions, dimensions),
          ),
        )
        .limit(1);
      return rows[0] ? toProfile(rows[0]) : null;
    },

    async insertProfile(tx: Tx, profile: EmbeddingProfileRecord) {
      await asTx(tx).insert(embeddingProfiles).values(profile);
    },

    async setProfileStatus(tx: Tx, profileId: string, status: EmbeddingProfileStatus) {
      await asTx(tx)
        .update(embeddingProfiles)
        .set({ status })
        .where(eq(embeddingProfiles.id, profileId));
    },

    async pending(workspaceId, profileId, limit): Promise<PendingChunk[]> {
      const rows = await db
        .select({
          chunkId: searchChunks.id,
          title: searchChunks.title,
          text: searchChunks.text,
        })
        .from(searchChunks)
        .leftJoin(
          embeddings,
          and(eq(embeddings.chunkId, searchChunks.id), eq(embeddings.profileId, profileId)),
        )
        .where(and(eq(searchChunks.workspaceId, workspaceId), isNull(embeddings.id)))
        // Oldest first, so a long fill makes visible progress from the top of
        // the workspace rather than wandering.
        .orderBy(asc(searchChunks.id))
        .limit(limit);
      return rows;
    },

    async countPending(workspaceId, profileId) {
      const rows = await db
        .select({ total: sql<number>`count(*)` })
        .from(searchChunks)
        .leftJoin(
          embeddings,
          and(eq(embeddings.chunkId, searchChunks.id), eq(embeddings.profileId, profileId)),
        )
        .where(and(eq(searchChunks.workspaceId, workspaceId), isNull(embeddings.id)));
      return Number(rows[0]?.total ?? 0);
    },

    async insertMany(tx: Tx, rows) {
      if (rows.length === 0) return;
      // Ignoring a conflict rather than failing: two passes that overlap have
      // both computed the same vector for the same chunk, and either will do.
      await asTx(tx)
        .insert(embeddings)
        .values([...rows])
        .onConflictDoNothing();
    },
  };
}
