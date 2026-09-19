import type {
  ActorId,
  PermissionAction,
  PermissionEffect,
  PolicyActionName,
  PolicyEffect,
  PolicySubject,
  ScopeSelector,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface PermissionGrantRecord {
  id: string;
  workspaceId: WorkspaceId;
  actorId: ActorId;
  action: PermissionAction;
  scope: ScopeSelector;
  effect: PermissionEffect;
  createdByActorId: ActorId;
  createdAt: Date;
}

export interface PermissionGrantRepository {
  insert(tx: Tx, grant: PermissionGrantRecord): Promise<void>;
  delete(tx: Tx, workspaceId: WorkspaceId, id: string): Promise<PermissionGrantRecord | null>;
  listForActor(workspaceId: WorkspaceId, actorId: ActorId): Promise<PermissionGrantRecord[]>;
  list(workspaceId: WorkspaceId): Promise<PermissionGrantRecord[]>;
}

export interface PolicyRuleRecord {
  id: string;
  workspaceId: WorkspaceId;
  priority: number;
  subject: PolicySubject;
  action: PolicyActionName;
  scope: ScopeSelector;
  effect: PolicyEffect;
  enabled: boolean;
  createdByActorId: ActorId;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyRuleRepository {
  upsert(tx: Tx, rule: PolicyRuleRecord): Promise<void>;
  delete(tx: Tx, workspaceId: WorkspaceId, id: string): Promise<PolicyRuleRecord | null>;
  findById(workspaceId: WorkspaceId, id: string): Promise<PolicyRuleRecord | null>;
  list(workspaceId: WorkspaceId): Promise<PolicyRuleRecord[]>;
}
