import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import type { IdempotencyRecord, IdempotencyRepository, Tx } from '@knoverge/core';
import { and, eq, lt } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { idempotencyRecords } from '../schema/idempotency.ts';
import { asTx } from '../unit-of-work.ts';

function toRecord(row: typeof idempotencyRecords.$inferSelect): IdempotencyRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    actorId: row.actorId as ActorId,
  };
}

export function createIdempotencyRepository(db: Database): IdempotencyRepository {
  return {
    async find(workspaceId: WorkspaceId, actorId: ActorId, key: string) {
      const rows = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.workspaceId, workspaceId),
            eq(idempotencyRecords.actorId, actorId),
            eq(idempotencyRecords.idempotencyKey, key),
          ),
        )
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async store(tx: Tx, record: IdempotencyRecord) {
      await asTx(tx)
        .insert(idempotencyRecords)
        .values(record)
        .onConflictDoUpdate({
          target: [
            idempotencyRecords.workspaceId,
            idempotencyRecords.actorId,
            idempotencyRecords.idempotencyKey,
          ],
          set: {
            requestHash: record.requestHash,
            response: record.response,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
          },
        });
    },
    async deleteExpired(tx: Tx, now: Date) {
      const rows = await asTx(tx)
        .delete(idempotencyRecords)
        .where(lt(idempotencyRecords.expiresAt, now))
        .returning({ key: idempotencyRecords.idempotencyKey });
      return rows.length;
    },
  };
}
