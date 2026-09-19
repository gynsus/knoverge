import type { ActorId, ScopeSelector, WorkspaceId } from '@knoverge/contracts';
import type {
  PermissionGrantRecord,
  PermissionGrantRepository,
  PolicyRuleRecord,
  PolicyRuleRepository,
  Tx,
} from '@knoverge/core';
import { EMPTY_SCOPE } from '@knoverge/policy';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { permissionGrants, policyRules } from '../schema/policy.ts';
import { asTx } from '../unit-of-work.ts';

function toScope(value: unknown): ScopeSelector {
  const scope = value as Partial<ScopeSelector> | null;
  return {
    categories: scope?.categories ?? EMPTY_SCOPE.categories,
    types: scope?.types ?? EMPTY_SCOPE.types,
    languages: scope?.languages ?? EMPTY_SCOPE.languages,
  };
}

function toGrant(row: typeof permissionGrants.$inferSelect): PermissionGrantRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    actorId: row.actorId as ActorId,
    createdByActorId: row.createdByActorId as ActorId,
    action: row.action as PermissionGrantRecord['action'],
    effect: row.effect as PermissionGrantRecord['effect'],
    scope: toScope(row.scope),
  };
}

function toRule(row: typeof policyRules.$inferSelect): PolicyRuleRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    createdByActorId: row.createdByActorId as ActorId,
    subject: row.subject as PolicyRuleRecord['subject'],
    action: row.action as PolicyRuleRecord['action'],
    effect: row.effect as PolicyRuleRecord['effect'],
    scope: toScope(row.scope),
  };
}

export function createPermissionGrantRepository(db: Database): PermissionGrantRepository {
  return {
    async insert(tx: Tx, grant: PermissionGrantRecord) {
      await asTx(tx).insert(permissionGrants).values(grant);
    },
    async delete(tx: Tx, workspaceId: WorkspaceId, id: string) {
      const rows = await asTx(tx)
        .delete(permissionGrants)
        .where(and(eq(permissionGrants.workspaceId, workspaceId), eq(permissionGrants.id, id)))
        .returning();
      return rows[0] ? toGrant(rows[0]) : null;
    },
    async listForActor(workspaceId: WorkspaceId, actorId: ActorId) {
      const rows = await db
        .select()
        .from(permissionGrants)
        .where(
          and(eq(permissionGrants.workspaceId, workspaceId), eq(permissionGrants.actorId, actorId)),
        )
        .orderBy(asc(permissionGrants.createdAt));
      return rows.map(toGrant);
    },
    async list(workspaceId: WorkspaceId) {
      const rows = await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.workspaceId, workspaceId))
        .orderBy(asc(permissionGrants.createdAt));
      return rows.map(toGrant);
    },
  };
}

export function createPolicyRuleRepository(db: Database): PolicyRuleRepository {
  return {
    async upsert(tx: Tx, rule: PolicyRuleRecord) {
      await asTx(tx)
        .insert(policyRules)
        .values(rule)
        .onConflictDoUpdate({
          target: policyRules.id,
          set: {
            priority: rule.priority,
            subject: rule.subject,
            action: rule.action,
            scope: rule.scope,
            effect: rule.effect,
            enabled: rule.enabled,
            updatedAt: rule.updatedAt,
          },
        });
    },
    async delete(tx: Tx, workspaceId: WorkspaceId, id: string) {
      const rows = await asTx(tx)
        .delete(policyRules)
        .where(and(eq(policyRules.workspaceId, workspaceId), eq(policyRules.id, id)))
        .returning();
      return rows[0] ? toRule(rows[0]) : null;
    },
    async findById(workspaceId: WorkspaceId, id: string) {
      const rows = await db
        .select()
        .from(policyRules)
        .where(and(eq(policyRules.workspaceId, workspaceId), eq(policyRules.id, id)))
        .limit(1);
      return rows[0] ? toRule(rows[0]) : null;
    },
    async list(workspaceId: WorkspaceId) {
      const rows = await db
        .select()
        .from(policyRules)
        .where(eq(policyRules.workspaceId, workspaceId))
        .orderBy(asc(policyRules.priority), asc(policyRules.id));
      return rows.map(toRule);
    },
  };
}
