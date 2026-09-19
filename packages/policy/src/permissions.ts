import type { PermissionAction } from '@knoverge/contracts';

import { scopeMatches } from './scope.ts';
import type { CategoryAncestors, Grant, Target } from './types.ts';

/**
 * Whether the actor holds the action anywhere at all, ignoring the target.
 *
 * A listing cannot be decided by one target: an actor whose grant covers one
 * branch may use the endpoint and see that branch. Refusing them outright,
 * which is what evaluating an empty target does, would hide everything.
 */
export function holdsAction(grants: readonly Grant[], action: PermissionAction): boolean {
  let allowed = false;
  for (const grant of grants) {
    if (grant.action !== action) continue;
    const unscoped =
      grant.scope.categories.length === 0 &&
      grant.scope.types.length === 0 &&
      grant.scope.languages.length === 0;
    // Only a workspace-wide deny takes the action away everywhere.
    if (grant.effect === 'deny' && unscoped) return false;
    if (grant.effect === 'allow') allowed = true;
  }
  return allowed;
}

export interface PermissionDecision {
  allowed: boolean;
  /** The grant that decided, when one applied. */
  grantId?: string;
  reason: 'explicit_deny' | 'explicit_allow' | 'no_grant';
}

/**
 * Evaluates permission grants for one action. Deny wins over allow, so a narrow
 * deny can carve an exception out of a broad allow.
 */
export function evaluatePermission(
  grants: readonly Grant[],
  action: PermissionAction,
  target: Target,
  ancestorsOf: CategoryAncestors,
): PermissionDecision {
  let allow: Grant | undefined;
  for (const grant of grants) {
    if (grant.action !== action) continue;
    if (!scopeMatches(grant.scope, target, ancestorsOf)) continue;
    if (grant.effect === 'deny') {
      return { allowed: false, grantId: grant.id, reason: 'explicit_deny' };
    }
    allow ??= grant;
  }
  return allow
    ? { allowed: true, grantId: allow.id, reason: 'explicit_allow' }
    : { allowed: false, reason: 'no_grant' };
}
