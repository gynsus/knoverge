import type { ActorId, UserId, WorkspaceId } from '@knoverge/contracts';
import type {
  MemberWithUser,
  MembershipRecord,
  MembershipRepository,
  MembershipWithWorkspace,
  Tx,
} from '@knoverge/core';
import { and, asc, count, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import { users, workspaceMemberships } from '../schema/users.ts';
import { workspaces } from '../schema/workspaces.ts';
import { asTx } from '../unit-of-work.ts';

function toRecord(row: typeof workspaceMemberships.$inferSelect): MembershipRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    userId: row.userId as UserId,
    actorId: row.actorId as ActorId,
    role: row.role as MembershipRecord['role'],
  };
}

export function createMembershipRepository(db: Database): MembershipRepository {
  return {
    async insert(tx: Tx, membership: MembershipRecord) {
      try {
        await asTx(tx).insert(workspaceMemberships).values(membership);
      } catch (err) {
        rethrowUniqueViolation(err, 'user is already a member of this workspace');
      }
    },
    async listForUser(userId: UserId): Promise<MembershipWithWorkspace[]> {
      const rows = await db
        .select({ membership: workspaceMemberships, slug: workspaces.slug, name: workspaces.name })
        .from(workspaceMemberships)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
        .where(eq(workspaceMemberships.userId, userId))
        .orderBy(asc(workspaces.createdAt));
      return rows.map((r) => ({
        ...toRecord(r.membership),
        workspaceSlug: r.slug,
        workspaceName: r.name,
      }));
    },
    async updateRole(
      tx: Tx,
      workspaceId: WorkspaceId,
      userId: UserId,
      role: MembershipRecord['role'],
    ) {
      const rows = await asTx(tx)
        .update(workspaceMemberships)
        .set({ role })
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, userId),
          ),
        )
        .returning({ id: workspaceMemberships.id });
      return rows.length > 0;
    },
    async remove(tx: Tx, workspaceId: WorkspaceId, userId: UserId) {
      const rows = await asTx(tx)
        .delete(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, userId),
          ),
        )
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async listForWorkspace(workspaceId: WorkspaceId): Promise<MemberWithUser[]> {
      const rows = await db
        .select({ membership: workspaceMemberships, user: users })
        .from(workspaceMemberships)
        .innerJoin(users, eq(users.id, workspaceMemberships.userId))
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
        .orderBy(asc(workspaceMemberships.createdAt));
      return rows.map((r) => ({
        ...toRecord(r.membership),
        email: r.user.email,
        displayName: r.user.displayName,
        status: r.user.status as MemberWithUser['status'],
        lastLoginAt: r.user.lastLoginAt,
      }));
    },
    async countByRole(workspaceId: WorkspaceId, role: MembershipRecord['role']) {
      const [row] = await db
        .select({ n: count() })
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.role, role),
          ),
        );
      return row?.n ?? 0;
    },
    async find(workspaceId: WorkspaceId, userId: UserId) {
      const rows = await db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
  };
}
