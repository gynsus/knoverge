import type { WorkspaceId } from '@knoverge/contracts';
import type {
  ActorRecord,
  ActorRepository,
  Tx,
  WorkspaceRecord,
  WorkspaceRepository,
} from '@knoverge/core';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { actors } from '../schema/actors.ts';
import { workspaces } from '../schema/workspaces.ts';
import { asTx } from '../unit-of-work.ts';

function toWorkspace(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  return { ...row, id: row.id as WorkspaceId };
}

export function createWorkspaceRepository(db: Database): WorkspaceRepository {
  return {
    async insert(tx: Tx, workspace: WorkspaceRecord) {
      await asTx(tx).insert(workspaces).values(workspace);
    },
    async findBySlug(slug: string) {
      const rows = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
      return rows[0] ? toWorkspace(rows[0]) : null;
    },
    async findById(id: WorkspaceId) {
      const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
      return rows[0] ? toWorkspace(rows[0]) : null;
    },
    async list() {
      const rows = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt));
      return rows.map(toWorkspace);
    },
  };
}

function toActor(row: typeof actors.$inferSelect): ActorRecord {
  return {
    ...row,
    id: row.id as ActorRecord['id'],
    workspaceId: row.workspaceId as WorkspaceId,
    type: row.type as ActorRecord['type'],
  };
}

export function createActorRepository(db: Database): ActorRepository {
  return {
    async insert(tx: Tx, actor: ActorRecord) {
      await asTx(tx).insert(actors).values(actor);
    },
    async findSystemActor(workspaceId: WorkspaceId) {
      const rows = await db
        .select()
        .from(actors)
        .where(and(eq(actors.workspaceId, workspaceId), eq(actors.type, 'system')))
        .limit(1);
      return rows[0] ? toActor(rows[0]) : null;
    },
  };
}
