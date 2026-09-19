import type { PolicyActionName, PolicyEffect } from '@knoverge/contracts';

import { scopeMatches } from './scope.ts';
import type { CategoryAncestors, Rule, Subject, Target } from './types.ts';

export interface PolicyDecision {
  effect: PolicyEffect;
  /** The rule that decided, when one matched. */
  ruleId?: string;
  reason: 'rule' | 'default';
}

function subjectMatches(rule: Rule, subject: Subject): boolean {
  if ('actor_id' in rule.subject) return rule.subject.actor_id === subject.actorId;
  if ('trust_tier' in rule.subject) return rule.subject.trust_tier === subject.trustTier;
  return rule.subject.actor_type === subject.actorType;
}

/**
 * First enabled rule matching subject, action and scope wins, ordered by
 * priority then by id so the outcome never depends on row order.
 */
export function evaluatePolicy(
  rules: readonly Rule[],
  subject: Subject,
  action: PolicyActionName,
  target: Target,
  fallback: PolicyEffect,
  ancestorsOf: CategoryAncestors,
): PolicyDecision {
  const candidates = rules
    .filter((rule) => rule.enabled && rule.action === action && subjectMatches(rule, subject))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of candidates) {
    if (scopeMatches(rule.scope, target, ancestorsOf)) {
      return { effect: rule.effect, ruleId: rule.id, reason: 'rule' };
    }
  }
  return { effect: fallback, reason: 'default' };
}
