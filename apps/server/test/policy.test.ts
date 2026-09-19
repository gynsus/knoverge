import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AgentResponse,
  CategoryResponse,
  IssueCredentialResponse,
  PermissionsResponse,
  PolicyRulesResponse,
  TaxonomyListResponse,
  type AgentSummary,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import type { WorkspaceId } from '@knoverge/contracts';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

let container: StartedPostgreSqlContainer;
let services: Services;
let app: FastifyInstance;
let admin: Browser;
let workspaceId: WorkspaceId;

class Browser {
  cookies = new Map<string, string>();
  csrf: string | undefined;

  async request(opts: InjectOptions & { url: string }) {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await app.inject({ ...opts, headers, cookies: Object.fromEntries(this.cookies) });
    for (const c of res.cookies) {
      if (c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  post(url: string, payload: unknown) {
    return this.request({ method: 'POST', url, payload: payload as Record<string, unknown> });
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
}

/** A request made with an agent bearer token and no cookies. */
function asAgent(token: string, opts: InjectOptions & { url: string }) {
  return app.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
}

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };

async function newAgent(
  name: string,
  trustTier = 'propose',
): Promise<{ agent: AgentSummary; token: string }> {
  const created = await admin.post('/v1/admin/agents.create', { name, trust_tier: trustTier });
  expect(created.statusCode, created.body).toBe(200);
  const agent = AgentResponse.parse(created.json()).agent;
  const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id });
  expect(issued.statusCode, issued.body).toBe(200);
  return { agent, token: IssueCredentialResponse.parse(issued.json()).token };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    ledgerKey: parseLedgerKey('09'.repeat(32)),
    tokenPepper: '1a'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: '2b'.repeat(32), cookieSecure: false },
  });
  admin = new Browser();
  admin.csrf = ((await admin.get('/v1/auth/csrf')).json() as { token: string }).token;
  const res = await admin.post('/v1/bootstrap', {
    ...OWNER,
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
  });
  expect(res.statusCode, res.body).toBe(200);
  workspaceId = (await services.repositories.workspaces.list())[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('implicit permissions', () => {
  it('lets an owner manage the taxonomy and policy', async () => {
    expect((await admin.get('/v1/admin/policy.rules')).statusCode).toBe(200);
    const created = await admin.post('/v1/admin/taxonomy.create', { name: 'Projects' });
    expect(created.statusCode, created.body).toBe(200);
  });

  it('gives a propose agent read access but no taxonomy management', async () => {
    const { token } = await newAgent('Reader agent');
    const list = await asAgent(token, { method: 'GET', url: '/v1/taxonomy.list' });
    expect(list.statusCode, list.body).toBe(200);
    expect(TaxonomyListResponse.parse(list.json()).categories.length).toBeGreaterThan(0);

    const create = await asAgent(token, {
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'Agent attempt' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBe('FORBIDDEN');
  });

  it('gives a read_only agent no proposal permissions', async () => {
    const { agent, token } = await newAgent('Read only agent', 'read_only');
    const decision = await services.authorization.check(
      {
        workspaceId: agent.workspace_id,
        actorId: agent.actor_id,
        actorType: 'agent',
        requestId: 'test',
      },
      { trustTier: 'read_only' },
      'knowledge.propose_create',
    );
    expect(decision.allowed).toBe(false);
    expect((await asAgent(token, { method: 'GET', url: '/v1/taxonomy.list' })).statusCode).toBe(
      200,
    );
  });

  it('never lets an agent reach agent administration', async () => {
    const { token } = await newAgent('Privileged wannabe', 'trusted');
    const res = await asAgent(token, { method: 'GET', url: '/v1/admin/agents.list' });
    expect(res.statusCode).toBe(403);
  });
});

describe('explicit grants', () => {
  it('grants taxonomy.manage to one agent and records the event', async () => {
    const { agent, token } = await newAgent('Curator agent');
    const before = await asAgent(token, {
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'Before grant' },
    });
    expect(before.statusCode).toBe(403);

    const granted = await admin.post('/v1/admin/permissions.grant', {
      actor_id: agent.actor_id,
      action: 'taxonomy.manage',
    });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(PermissionsResponse.parse(granted.json()).grants).toHaveLength(1);

    const after = await asAgent(token, {
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'After grant' },
    });
    // A bearer request carries no ambient authority, so no CSRF token is needed.
    expect(after.statusCode, after.body).toBe(200);
    expect(CategoryResponse.parse(after.json()).category.path).toBe('after-grant');

    const events = await services.repositories.events.listAfter(workspaceId, 0, 1000);
    expect(events.some((e) => e.eventType === 'permission.granted')).toBe(true);
    const denied = events.filter((e) => e.eventType === 'command.denied');
    expect(denied.at(-1)?.metadata).toMatchObject({
      action: 'taxonomy.manage',
      reason: 'no_grant',
    });
    expect((await services.ledger.verify(workspaceId)).ok).toBe(true);
  });

  it('revoking the grant removes the access again', async () => {
    const { agent, token } = await newAgent('Temporary curator');
    await admin.post('/v1/admin/permissions.grant', {
      actor_id: agent.actor_id,
      action: 'taxonomy.manage',
    });
    const list = PermissionsResponse.parse(
      (await admin.get(`/v1/admin/permissions.list?actor_id=${agent.actor_id}`)).json(),
    );
    expect(list.grants).toHaveLength(1);
    const revoke = await admin.post('/v1/admin/permissions.revoke', {
      grant_id: list.grants[0]!.id,
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const after = await asAgent(token, {
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'After revoke' },
    });
    expect(after.statusCode).toBe(403);
  });

  it('an explicit deny overrides the role of a human', async () => {
    const reviewer = await services.users.prepare({
      email: 'reviewer@example.com',
      password: 'a sufficiently long passphrase',
      displayName: 'Reviewer',
    });
    const { addMember } = await import('@knoverge/core');
    let actorId = '';
    await services.uow.run(async (tx) => {
      await services.users.insert(tx, reviewer);
      const added = await addMember(
        {
          memberships: services.repositories.memberships,
          actors: services.repositories.actors,
          ledger: services.ledger,
        },
        tx,
        (await services.repositories.workspaces.list())[0]!.id,
        reviewer,
        'admin',
        'test',
        new Date(),
      );
      actorId = added.actorId;
    });

    const browser = new Browser();
    browser.csrf = ((await browser.get('/v1/auth/csrf')).json() as { token: string }).token;
    expect(
      (
        await browser.post('/v1/auth/login', {
          email: 'reviewer@example.com',
          password: 'a sufficiently long passphrase',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await browser.post('/v1/admin/taxonomy.create', { name: 'Admin may' })).statusCode,
    ).toBe(200);

    await admin.post('/v1/admin/permissions.grant', {
      actor_id: actorId,
      action: 'taxonomy.manage',
      effect: 'deny',
    });
    const after = await browser.post('/v1/admin/taxonomy.create', { name: 'Admin may not' });
    expect(after.statusCode).toBe(403);
    // Reading is untouched by the deny.
    expect((await browser.get('/v1/taxonomy.list')).statusCode).toBe(200);
  });

  it('refuses a scope naming an unknown category', async () => {
    const { agent } = await newAgent('Scoped agent');
    const res = await admin.post('/v1/admin/permissions.grant', {
      actor_id: agent.actor_id,
      action: 'knowledge.read',
      scope: { categories: [{ category_id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1T3' }] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('policy rules', () => {
  it('keeps a trusted agent on review until a scoped rule says otherwise', async () => {
    const { agent } = await newAgent('Trusted writer', 'trusted');
    const actor = {
      workspaceId: agent.workspace_id,
      actorId: agent.actor_id,
      actorType: 'agent' as const,
      requestId: 'test',
    };
    const standing = { trustTier: 'trusted' as const };
    expect(await services.authorization.policyFor(actor, standing, 'knowledge.create')).toBe(
      'require_review',
    );

    const created = await admin.post('/v1/admin/taxonomy.create', { name: 'Policy scope' });
    const category = CategoryResponse.parse(created.json()).category;
    const upsert = await admin.post('/v1/admin/policy.rules.upsert', {
      priority: 10,
      subject: { actor_id: agent.actor_id },
      action: 'knowledge.create',
      scope: {
        categories: [{ category_id: category.id, include_descendants: true }],
        types: ['observation'],
      },
      effect: 'allow_direct',
    });
    expect(upsert.statusCode, upsert.body).toBe(200);

    expect(
      await services.authorization.policyFor(actor, standing, 'knowledge.create', {
        categoryIds: [category.id],
        type: 'observation',
      }),
    ).toBe('allow_direct');
    // Outside the scope the default still applies.
    expect(
      await services.authorization.policyFor(actor, standing, 'knowledge.create', {
        categoryIds: [category.id],
        type: 'decision',
      }),
    ).toBe('require_review');
    expect(await services.authorization.policyFor(actor, standing, 'knowledge.create')).toBe(
      'require_review',
    );
  });

  it('updates, disables and deletes a rule', async () => {
    const upsert = await admin.post('/v1/admin/policy.rules.upsert', {
      priority: 50,
      subject: { actor_type: 'agent' },
      action: 'knowledge.delete',
      effect: 'deny',
    });
    const rule = upsert.json().rule as { id: string };
    const disabled = await admin.post('/v1/admin/policy.rules.upsert', {
      rule_id: rule.id,
      priority: 50,
      subject: { actor_type: 'agent' },
      action: 'knowledge.delete',
      effect: 'deny',
      enabled: false,
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const rules = PolicyRulesResponse.parse((await admin.get('/v1/admin/policy.rules')).json());
    expect(rules.rules.find((r) => r.id === rule.id)?.enabled).toBe(false);

    expect(
      (await admin.post('/v1/admin/policy.rules.delete', { rule_id: rule.id })).statusCode,
    ).toBe(200);
    const after = PolicyRulesResponse.parse((await admin.get('/v1/admin/policy.rules')).json());
    expect(after.rules.map((r) => r.id)).not.toContain(rule.id);
    expect(
      (await admin.post('/v1/admin/policy.rules.delete', { rule_id: rule.id })).statusCode,
    ).toBe(404);
  });

  it('refuses policy administration without the permission', async () => {
    const { token } = await newAgent('Policy wannabe', 'trusted');
    expect(
      (await asAgent(token, { method: 'GET', url: '/v1/admin/policy.rules' })).statusCode,
    ).toBe(403);
  });
});
