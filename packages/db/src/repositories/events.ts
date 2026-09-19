import type { EventId, WorkspaceId } from '@knoverge/contracts';
import type { EventRecord, EventRepository, LedgerHead, Tx } from '@knoverge/core';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { events } from '../schema/events.ts';
import { asTx } from '../unit-of-work.ts';

type Row = typeof events.$inferSelect;

function toRecord(row: Row): EventRecord {
  return {
    ...row,
    id: row.id as EventId,
    workspaceId: row.workspaceId as WorkspaceId,
    eventType: row.eventType as EventRecord['eventType'],
    objectType: row.objectType as EventRecord['objectType'],
  };
}

export function createEventRepository(db: Database): EventRepository {
  return {
    async lockAndGetHead(tx: Tx, workspaceId: WorkspaceId): Promise<LedgerHead | null> {
      const t = asTx(tx);
      // Serialises appends per workspace for the rest of the transaction (ADR 0007).
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
      const head = await t
        .select({ sequence: events.sequence, eventHash: events.eventHash })
        .from(events)
        .where(eq(events.workspaceId, workspaceId))
        .orderBy(desc(events.sequence))
        .limit(1);
      return head[0] ?? null;
    },

    async insert(tx: Tx, record: EventRecord): Promise<void> {
      await asTx(tx).insert(events).values(record);
    },

    async listAfter(workspaceId: WorkspaceId, afterSequence: number, limit: number) {
      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.workspaceId, workspaceId), gt(events.sequence, afterSequence)))
        .orderBy(asc(events.sequence))
        .limit(limit);
      return rows.map(toRecord);
    },
  };
}
