import type { ActorId, CategoryId, PermissionAction, ScopeSelector } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_SCOPE,
  ROLE_PERMISSIONS,
  TIER_PERMISSIONS,
  TIER_POLICY_DEFAULT,
  evaluatePermission,
  evaluatePolicy,
  scopeMatches,
  type Grant,
  type Rule,
  type Subject,
} from '../src/index.ts';

/**
 * projects
 *   projects/pixel        (cat_pixel)
 *     projects/pixel/arch (cat_arch)
 *   projects/other        (cat_other)
 * career                  (cat_career)
 */
const ANCESTORS: Record<string, string[]> = {
  cat_projects: [],
  cat_pixel: ['cat_projects'],
  cat_arch: ['cat_projects', 'cat_pixel'],
  cat_other: ['cat_projects'],
  cat_career: [],
};
const ancestorsOf = (id: string) => ANCESTORS[id] ?? [];

function scope(partial: Partial<ScopeSelector>): ScopeSelector {
  return { ...EMPTY_SCOPE, ...partial };
}

function grant(partial: Partial<Grant> & Pick<Grant, 'action'>): Grant {
  return {
    id: partial.id ?? 'grant_1',
    actorId: (partial.actorId ?? 'act_1') as ActorId,
    scope: partial.scope ?? EMPTY_SCOPE,
    effect: partial.effect ?? 'allow',
    action: partial.action,
  };
}

const agent: Subject = {
  actorId: 'act_agent' as ActorId,
  actorType: 'agent',
  trustTier: 'propose',
};

describe('scopeMatches', () => {
  it('matches everything when nothing is constrained', () => {
    expect(scopeMatches(EMPTY_SCOPE, {}, ancestorsOf)).toBe(true);
    expect(
      scopeMatches(EMPTY_SCOPE, { categoryIds: ['cat_arch'], type: 'fact' }, ancestorsOf),
    ).toBe(true);
  });

  it('matches a category and its descendants', () => {
    const s = scope({
      categories: [{ category_id: 'cat_pixel' as CategoryId, include_descendants: true }],
    });
    expect(scopeMatches(s, { categoryIds: ['cat_pixel'] }, ancestorsOf)).toBe(true);
    expect(scopeMatches(s, { categoryIds: ['cat_arch'] }, ancestorsOf)).toBe(true);
    expect(scopeMatches(s, { categoryIds: ['cat_other'] }, ancestorsOf)).toBe(false);
    expect(scopeMatches(s, { categoryIds: ['cat_projects'] }, ancestorsOf)).toBe(false);
  });

  it('excludes descendants when the scope says so', () => {
    const s = scope({
      categories: [{ category_id: 'cat_pixel' as CategoryId, include_descendants: false }],
    });
    expect(scopeMatches(s, { categoryIds: ['cat_pixel'] }, ancestorsOf)).toBe(true);
    expect(scopeMatches(s, { categoryIds: ['cat_arch'] }, ancestorsOf)).toBe(false);
  });

  it('requires every category of the target to be covered', () => {
    const s = scope({
      categories: [{ category_id: 'cat_pixel' as CategoryId, include_descendants: true }],
    });
    expect(scopeMatches(s, { categoryIds: ['cat_arch', 'cat_pixel'] }, ancestorsOf)).toBe(true);
    // Filed in a permitted and a restricted branch: not reachable through the permitted one.
    expect(scopeMatches(s, { categoryIds: ['cat_arch', 'cat_career'] }, ancestorsOf)).toBe(false);
  });

  it('does not let a category-scoped rule cover uncategorised objects', () => {
    const s = scope({
      categories: [{ category_id: 'cat_pixel' as CategoryId, include_descendants: true }],
    });
    expect(scopeMatches(s, {}, ancestorsOf)).toBe(false);
    expect(scopeMatches(s, { categoryIds: [] }, ancestorsOf)).toBe(false);
  });

  it('constrains types and languages independently', () => {
    const s = scope({ types: ['observation', 'episode'], languages: ['en'] });
    expect(scopeMatches(s, { type: 'observation', language: 'en' }, ancestorsOf)).toBe(true);
    expect(scopeMatches(s, { type: 'decision', language: 'en' }, ancestorsOf)).toBe(false);
    expect(scopeMatches(s, { type: 'observation', language: 'ru' }, ancestorsOf)).toBe(false);
    expect(scopeMatches(s, { type: 'observation' }, ancestorsOf)).toBe(false);
  });
});

describe('evaluatePermission', () => {
  const read: PermissionAction = 'knowledge.read';

  it('refuses when no grant applies', () => {
    expect(evaluatePermission([], read, {}, ancestorsOf)).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
    expect(
      evaluatePermission([grant({ action: 'knowledge.search' })], read, {}, ancestorsOf).allowed,
    ).toBe(false);
  });

  it('allows through a matching grant', () => {
    const decision = evaluatePermission(
      [grant({ action: read, id: 'grant_a' })],
      read,
      {},
      ancestorsOf,
    );
    expect(decision).toEqual({ allowed: true, grantId: 'grant_a', reason: 'explicit_allow' });
  });

  it('lets a narrow deny override a broad allow, whatever the order', () => {
    const broad = grant({ action: read, id: 'grant_allow' });
    const narrow = grant({
      action: read,
      id: 'grant_deny',
      effect: 'deny',
      scope: scope({
        categories: [{ category_id: 'cat_career' as CategoryId, include_descendants: true }],
      }),
    });
    const target = { categoryIds: ['cat_career'] };
    expect(evaluatePermission([broad, narrow], read, target, ancestorsOf).allowed).toBe(false);
    expect(evaluatePermission([narrow, broad], read, target, ancestorsOf).allowed).toBe(false);
    // Outside the denied branch the broad allow still applies.
    expect(
      evaluatePermission([broad, narrow], read, { categoryIds: ['cat_pixel'] }, ancestorsOf)
        .allowed,
    ).toBe(true);
  });

  it('ignores a grant whose scope does not match', () => {
    const scoped = grant({
      action: read,
      scope: scope({
        categories: [{ category_id: 'cat_pixel' as CategoryId, include_descendants: true }],
      }),
    });
    expect(
      evaluatePermission([scoped], read, { categoryIds: ['cat_career'] }, ancestorsOf).allowed,
    ).toBe(false);
  });
});

describe('evaluatePolicy', () => {
  function rule(partial: Partial<Rule> & Pick<Rule, 'effect'>): Rule {
    return {
      id: partial.id ?? 'rule_1',
      priority: partial.priority ?? 10,
      subject: partial.subject ?? { trust_tier: 'propose' },
      action: partial.action ?? 'knowledge.create',
      scope: partial.scope ?? EMPTY_SCOPE,
      enabled: partial.enabled ?? true,
      effect: partial.effect,
    };
  }

  it('falls back when nothing matches', () => {
    expect(
      evaluatePolicy([], agent, 'knowledge.create', {}, 'require_review', ancestorsOf),
    ).toEqual({
      effect: 'require_review',
      reason: 'default',
    });
  });

  it('takes the first matching rule by priority', () => {
    const rules = [
      rule({ id: 'rule_b', priority: 20, effect: 'allow_direct' }),
      rule({ id: 'rule_a', priority: 10, effect: 'deny' }),
    ];
    expect(
      evaluatePolicy(rules, agent, 'knowledge.create', {}, 'require_review', ancestorsOf),
    ).toMatchObject({
      effect: 'deny',
      ruleId: 'rule_a',
    });
  });

  it('breaks priority ties by id so the outcome never depends on row order', () => {
    const rules = [
      rule({ id: 'rule_z', priority: 10, effect: 'deny' }),
      rule({ id: 'rule_a', priority: 10, effect: 'allow_direct' }),
    ];
    expect(
      evaluatePolicy(rules, agent, 'knowledge.create', {}, 'require_review', ancestorsOf).ruleId,
    ).toBe('rule_a');
    expect(
      evaluatePolicy(
        [...rules].reverse(),
        agent,
        'knowledge.create',
        {},
        'require_review',
        ancestorsOf,
      ).ruleId,
    ).toBe('rule_a');
  });

  it('skips disabled rules and other subjects, actions and scopes', () => {
    const fallback = 'require_review' as const;
    const disabled = rule({ effect: 'allow_direct', enabled: false });
    expect(
      evaluatePolicy([disabled], agent, 'knowledge.create', {}, fallback, ancestorsOf).reason,
    ).toBe('default');
    const otherSubject = rule({ effect: 'allow_direct', subject: { trust_tier: 'trusted' } });
    expect(
      evaluatePolicy([otherSubject], agent, 'knowledge.create', {}, fallback, ancestorsOf).reason,
    ).toBe('default');
    const otherAction = rule({ effect: 'allow_direct', action: 'knowledge.delete' });
    expect(
      evaluatePolicy([otherAction], agent, 'knowledge.create', {}, fallback, ancestorsOf).reason,
    ).toBe('default');
    const scoped = rule({
      effect: 'allow_direct',
      scope: scope({
        categories: [{ category_id: 'cat_pixel' as CategoryId, include_descendants: true }],
      }),
    });
    expect(
      evaluatePolicy(
        [scoped],
        agent,
        'knowledge.create',
        { categoryIds: ['cat_career'] },
        fallback,
        ancestorsOf,
      ).reason,
    ).toBe('default');
    expect(
      evaluatePolicy(
        [scoped],
        agent,
        'knowledge.create',
        { categoryIds: ['cat_arch'] },
        fallback,
        ancestorsOf,
      ).effect,
    ).toBe('allow_direct');
  });

  it('matches a subject by actor id or actor type', () => {
    const byActor = rule({ effect: 'allow_direct', subject: { actor_id: agent.actorId } });
    expect(
      evaluatePolicy([byActor], agent, 'knowledge.create', {}, 'deny', ancestorsOf).effect,
    ).toBe('allow_direct');
    const byType = rule({ effect: 'deny', subject: { actor_type: 'agent' } });
    expect(
      evaluatePolicy([byType], agent, 'knowledge.create', {}, 'allow_direct', ancestorsOf).effect,
    ).toBe('deny');
  });
});

describe('defaults', () => {
  it('gives the propose tier taxonomy.propose but no write', () => {
    expect(TIER_PERMISSIONS.propose).toContain('taxonomy.propose');
    expect(TIER_PERMISSIONS.propose).not.toContain('knowledge.write');
    expect(TIER_PERMISSIONS.propose).not.toContain('knowledge.approve');
  });

  it('keeps every agent tier on review by default', () => {
    expect(TIER_POLICY_DEFAULT.trusted).toBe('require_review');
    expect(TIER_POLICY_DEFAULT.propose).toBe('require_review');
    expect(TIER_POLICY_DEFAULT.read_only).toBe('deny');
  });

  it('never gives a viewer a write or approval permission', () => {
    for (const action of ROLE_PERMISSIONS.viewer) {
      expect(action).not.toMatch(/write|approve|manage|propose_/);
    }
  });

  it('grows permissions monotonically with the role', () => {
    const rank = ['viewer', 'reviewer', 'admin', 'owner'] as const;
    for (let i = 1; i < rank.length; i += 1) {
      const lower = new Set<string>(ROLE_PERMISSIONS[rank[i - 1]!]);
      for (const action of lower) {
        expect(ROLE_PERMISSIONS[rank[i]!]).toContain(action);
      }
    }
  });
});
