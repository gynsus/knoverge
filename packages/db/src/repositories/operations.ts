import type { ActorId, AgentId, WorkspaceId } from '@knoverge/contracts';
import type { OperationPatch, OperationRecord, OperationRepository, Tx } from '@knoverge/core';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { operations } from '../schema/operations.ts';
import { asTx } from '../unit-of-work.ts';

function toOperation(row: typeof operations.$inferSelect): OperationRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    actorId: row.actorId as ActorId,
    agentId: row.agentId as AgentId | null,
    operationType: row.operationType as OperationRecord['operationType'],
    state: row.state as OperationRecord['state'],
    objectIds: row.objectIds,
    error: row.error,
  };
}

/** Operations that started and never reached db_committed. */
const UNFINISHED = ['pending', 'git_committed'];

export function createOperationRepository(db: Database): OperationRepository {
  return {
    async insert(tx: Tx, operation: OperationRecord) {
      await asTx(tx).insert(operations).values(operation);
    },
    async update(tx: Tx, workspaceId: WorkspaceId, id: string, patch: OperationPatch) {
      await asTx(tx)
        .update(operations)
        .set(patch as Partial<typeof operations.$inferInsert>)
        .where(and(eq(operations.workspaceId, workspaceId), eq(operations.id, id)));
    },
    async findById(workspaceId: WorkspaceId, id: string, tx?: Tx) {
      const rows = await (tx ? asTx(tx) : db)
        .select()
        .from(operations)
        .where(and(eq(operations.workspaceId, workspaceId), eq(operations.id, id)))
        .limit(1);
      return rows[0] ? toOperation(rows[0]) : null;
    },
    async listUnfinished(workspaceId: WorkspaceId, limit = 100) {
      const rows = await db
        .select()
        .from(operations)
        .where(and(eq(operations.workspaceId, workspaceId), inArray(operations.state, UNFINISHED)))
        .orderBy(asc(operations.createdAt))
        .limit(limit);
      return rows.map(toOperation);
    },
  };
}
