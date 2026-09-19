import type { ActorId, UserId, WorkspaceId } from '@knoverge/contracts';
import type {
  MembershipRecord,
  MembershipRepository,
  MembershipWithWorkspace,
  Tx,
} from '@knoverge/core';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import { workspaceMemberships } from '../schema/users.ts';
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
