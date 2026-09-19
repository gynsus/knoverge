import type { SessionId, UserId } from '@knoverge/contracts';
import type { SessionRecord, SessionRepository, Tx } from '@knoverge/core';
import { and, desc, eq, gt, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { humanSessions } from '../schema/users.ts';
import { asTx } from '../unit-of-work.ts';

function toRecord(row: typeof humanSessions.$inferSelect): SessionRecord {
  return { ...row, id: row.id as SessionId, userId: row.userId as UserId };
}

export function createSessionRepository(db: Database): SessionRepository {
  return {
    async insert(tx: Tx, session: SessionRecord) {
      await asTx(tx).insert(humanSessions).values(session);
    },
    async findActiveByTokenHash(tokenHash: string, now: Date) {
      const rows = await db
        .select()
        .from(humanSessions)
        .where(
          and(
            eq(humanSessions.tokenHash, tokenHash),
            isNull(humanSessions.revokedAt),
            gt(humanSessions.expiresAt, now),
          ),
        )
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async listActiveForUser(userId: UserId, now: Date) {
      const rows = await db
        .select()
        .from(humanSessions)
        .where(
          and(
            eq(humanSessions.userId, userId),
            isNull(humanSessions.revokedAt),
            gt(humanSessions.expiresAt, now),
          ),
        )
        .orderBy(desc(humanSessions.createdAt));
      return rows.map(toRecord);
    },
    async revoke(tx: Tx, id: SessionId, at: Date) {
      const rows = await asTx(tx)
        .update(humanSessions)
        .set({ revokedAt: at })
        .where(and(eq(humanSessions.id, id), isNull(humanSessions.revokedAt)))
        .returning({ id: humanSessions.id });
      return rows.length > 0;
    },
    async revokeAllForUser(tx: Tx, userId: UserId, at: Date, except?: SessionId) {
      const conditions = [eq(humanSessions.userId, userId), isNull(humanSessions.revokedAt)];
      if (except) conditions.push(ne(humanSessions.id, except));
      const rows = await asTx(tx)
        .update(humanSessions)
        .set({ revokedAt: at })
        .where(and(...conditions))
        .returning({ id: humanSessions.id });
      return rows.length;
    },
    async deleteEndedBefore(tx: Tx, before: Date) {
      const rows = await asTx(tx)
        .delete(humanSessions)
        .where(
          or(
            lt(humanSessions.expiresAt, before),
            and(isNotNull(humanSessions.revokedAt), lt(humanSessions.revokedAt, before)),
          ),
        )
        .returning({ id: humanSessions.id });
      return rows.length;
    },
  };
}
