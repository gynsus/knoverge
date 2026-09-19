import type {
  ActorId,
  ActorType,
  PermissionAction,
  PermissionEffect,
  PolicyActionName,
  PolicyEffect,
  PolicySubject,
  ScopeSelector,
  TrustTier,
} from '@knoverge/contracts';

export interface Grant {
  id: string;
  actorId: ActorId;
  action: PermissionAction;
  scope: ScopeSelector;
  effect: PermissionEffect;
}

export interface Rule {
  id: string;
  priority: number;
  subject: PolicySubject;
  action: PolicyActionName;
  scope: ScopeSelector;
  effect: PolicyEffect;
  enabled: boolean;
}

/** What the caller is acting on. Absent fields are treated as unconstrained. */
export interface Target {
  /** Categories the object belongs to, as stable ids. */
  categoryIds?: string[];
  type?: string;
  language?: string;
}

export interface Subject {
  actorId: ActorId;
  actorType: ActorType;
  trustTier?: TrustTier;
}

/** Resolves a category id to its ancestor chain, closest ancestor last. */
export type CategoryAncestors = (categoryId: string) => string[];
