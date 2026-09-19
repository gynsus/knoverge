export {
  ROLE_PERMISSIONS,
  ROLE_POLICY_DEFAULT,
  TIER_PERMISSIONS,
  TIER_POLICY_DEFAULT,
} from './defaults.ts';
export { evaluatePermission, type PermissionDecision } from './permissions.ts';
export { evaluatePolicy, type PolicyDecision } from './rules.ts';
export { EMPTY_SCOPE, scopeMatches } from './scope.ts';
export type { CategoryAncestors, Grant, Rule, Subject, Target } from './types.ts';
