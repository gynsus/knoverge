import type { WorkspaceId } from '@knoverge/contracts';
import type {
  ActorRecord,
  ActorRepository,
  Tx,
  WorkspacePatch,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceStats,
} from '@knoverge/core';
import { and, asc, count, eq, inArray, max } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import { actors } from '../schema/actors.ts';
import { agents } from '../schema/agents.ts';
import { events } from '../schema/events.ts';
import { knowledgeItems } from '../schema/knowledge.ts';
import { workspaces } from '../schema/workspaces.ts';
import { asTx } from '../unit-of-work.ts';

function toWorkspace(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  return { ...row, id: row.id as WorkspaceId };
}

export function createWorkspaceRepository(db: Database): WorkspaceRepository {
  return {
    async insert(tx: Tx, workspace: WorkspaceRecord) {
      try {
        await asTx(tx).insert(workspaces).values(workspace);
      } catch (err) {
        rethrowUniqueViolation(err, `workspace slug already exists: ${workspace.slug}`, {
          slug: workspace.slug,
        });
      }
    },
    async update(tx: Tx, id: WorkspaceId, patch: WorkspacePatch) {
      await asTx(tx)
        .update(workspaces)
        .set(patch as Partial<typeof workspaces.$inferInsert>)
        .where(eq(workspaces.id, id));
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
    async statsFor(workspaceIds) {
      const stats = new Map<WorkspaceId, WorkspaceStats>();
      if (workspaceIds.length === 0) return stats;
      const ids = [...workspaceIds];
      for (const id of ids) stats.set(id, { items: 0, agents: 0, lastActivityAt: null });

      const [itemRows, agentRows, activityRows] = await Promise.all([
        db
          .select({ workspaceId: knowledgeItems.workspaceId, total: count() })
          .from(knowledgeItems)
          .where(inArray(knowledgeItems.workspaceId, ids))
          .groupBy(knowledgeItems.workspaceId),
        db
          .select({ workspaceId: agents.workspaceId, total: count() })
          .from(agents)
          .where(inArray(agents.workspaceId, ids))
          .groupBy(agents.workspaceId),
        // The ledger is append-only, so its newest row is the last time
        // anything material happened. `workspaces.updated_at` would answer a
        // narrower question: when the settings were last edited.
        db
          .select({ workspaceId: events.workspaceId, at: max(events.createdAt) })
          .from(events)
          .where(inArray(events.workspaceId, ids))
          .groupBy(events.workspaceId),
      ]);

      for (const row of itemRows) {
        const entry = stats.get(row.workspaceId as WorkspaceId);
        if (entry) entry.items = row.total;
      }
      for (const row of agentRows) {
        const entry = stats.get(row.workspaceId as WorkspaceId);
        if (entry) entry.agents = row.total;
      }
      for (const row of activityRows) {
        const entry = stats.get(row.workspaceId as WorkspaceId);
        if (entry) entry.lastActivityAt = row.at ?? null;
      }
      return stats;
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
    async findById(workspaceId: WorkspaceId, id: ActorRecord['id'], tx?: Tx) {
      const rows = await (tx ? asTx(tx) : db)
        .select()
        .from(actors)
        .where(and(eq(actors.workspaceId, workspaceId), eq(actors.id, id)))
        .limit(1);
      return rows[0] ? toActor(rows[0]) : null;
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
