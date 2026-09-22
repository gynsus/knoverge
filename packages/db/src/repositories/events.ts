import type { EventFeedOptions } from '@knoverge/core';
import type { EventId, WorkspaceId } from '@knoverge/contracts';
import type { EventRecord, EventRepository, LedgerHead, Tx } from '@knoverge/core';
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';

import { LOCK_LEDGER } from '../locks.ts';

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
      await t.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_LEDGER}, hashtext(${workspaceId}))`);
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
    async listFeed(workspaceId: WorkspaceId, options: EventFeedOptions) {
      const where = [
        eq(events.workspaceId, workspaceId),
        gt(events.sequence, options.afterSequence),
      ];
      if (options.eventTypes?.length) {
        where.push(inArray(events.eventType, [...options.eventTypes]));
      }
      if (options.actorId) where.push(eq(events.actorId, options.actorId));
      if (options.since) where.push(gte(events.createdAt, options.since));
      if (options.until) where.push(lte(events.createdAt, options.until));
      if (options.categoryIds?.length) {
        // The snapshot the event carries, so scope is answered without
        // joining current state (ADR 0010): an item that has since moved is
        // still shown to whoever could see it when it changed.
        where.push(
          sql`${events.categoryIds} ?| ${sql.raw(
            `ARRAY[${options.categoryIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]`,
          )}`,
        );
      }
      const rows = await db
        .select()
        .from(events)
        .where(and(...where))
        .orderBy(options.newestFirst ? desc(events.sequence) : asc(events.sequence))
        .limit(options.limit);
      return rows.map(toRecord);
    },
    async latestSequence(workspaceId: WorkspaceId) {
      const rows = await db
        .select({ sequence: events.sequence })
        .from(events)
        .where(eq(events.workspaceId, workspaceId))
        .orderBy(desc(events.sequence))
        .limit(1);
      return rows[0]?.sequence ?? 0;
    },
  };
}
