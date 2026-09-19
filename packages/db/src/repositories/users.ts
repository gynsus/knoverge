import type { UserId } from '@knoverge/contracts';
import type { Tx, UserRecord, UserRepository } from '@knoverge/core';
import { count, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import { users } from '../schema/users.ts';
import { asTx } from '../unit-of-work.ts';

function toRecord(row: typeof users.$inferSelect): UserRecord {
  return { ...row, id: row.id as UserId, status: row.status as UserRecord['status'] };
}

export function createUserRepository(db: Database): UserRepository {
  return {
    async insert(tx: Tx, user: UserRecord) {
      try {
        await asTx(tx).insert(users).values(user);
      } catch (err) {
        rethrowUniqueViolation(err, 'email address already registered');
      }
    },
    async findByEmail(email: string) {
      const rows = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = lower(${email})`)
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async findById(id: UserId) {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async count() {
      const [row] = await db.select({ n: count() }).from(users);
      return row?.n ?? 0;
    },
    async recordLoginFailure(
      tx: Tx,
      id: UserId,
      lockAfter: number,
      lockedUntil: Date,
      resetBefore: Date | null,
    ) {
      // One statement, so parallel attempts add up instead of overwriting each
      // other. An expired lockout resets the count first: otherwise a user who
      // was locked once is locked again by their next single mistyped password.
      const base = resetBefore
        ? sql`CASE WHEN ${users.lockedUntil} IS NOT NULL AND ${users.lockedUntil} <= ${resetBefore} THEN 0 ELSE ${users.failedLoginCount} END`
        : sql`${users.failedLoginCount}`;
      const next = sql`${base} + 1`;
      const rows = await asTx(tx)
        .update(users)
        .set({
          failedLoginCount: next,
          lockedUntil: sql`CASE WHEN ${next} >= ${lockAfter} THEN ${lockedUntil}::timestamptz ELSE NULL END`,
        })
        .where(eq(users.id, id))
        .returning({ failedLoginCount: users.failedLoginCount });
      return rows[0]?.failedLoginCount ?? 0;
    },
    async recordLoginSuccess(tx: Tx, id: UserId, at: Date) {
      await asTx(tx)
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: at })
        .where(eq(users.id, id));
    },
    async updatePassword(tx: Tx, id: UserId, passwordHash: string, at: Date) {
      await asTx(tx)
        .update(users)
        .set({ passwordHash, passwordChangedAt: at })
        .where(eq(users.id, id));
    },
  };
}
