import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AgentResponse,
  AgentsResponse,
  CredentialsResponse,
  IssueCredentialResponse,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { WORKSPACE_HEADER } from '../src/plugins/actor-context.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

let container: StartedPostgreSqlContainer;
let services: Services;
let app: FastifyInstance;
// Signing in once per role keeps the per-IP login limit out of these tests.
let adminBrowser: Browser;
let viewerBrowser: Browser;

/** A signed-in browser session. */
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

  async signIn(email: string, password: string) {
    const csrf = await this.request({ method: 'GET', url: '/v1/auth/csrf' });
    this.csrf = (csrf.json() as { token: string }).token;
    const res = await this.post('/v1/auth/login', { email, password });
    expect(res.statusCode, res.body).toBe(200);
    return this;
  }
}

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };
const VIEWER = { email: 'viewer@example.com', password: 'a different long passphrase' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    ledgerKey: parseLedgerKey('a1'.repeat(32)),
    tokenPepper: 'b2'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'c3'.repeat(32), cookieSecure: false },
  });

  const setup = new Browser();
  const csrf = await setup.request({ method: 'GET', url: '/v1/auth/csrf' });
  setup.csrf = (csrf.json() as { token: string }).token;
  const res = await setup.post('/v1/bootstrap', {
    ...OWNER,
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
  });
  expect(res.statusCode, res.body).toBe(200);

  // A second user with a viewer membership, for role checks.
  const viewer = await services.users.prepare({
    email: VIEWER.email,
    password: VIEWER.password,
    displayName: 'Viewer',
  });
  const workspace = (await services.repositories.workspaces.list())[0]!;
  await services.uow.run(async (tx) => {
    await services.users.insert(tx, viewer);
    const { addMember } = await import('@knoverge/core');
    await addMember(
      {
        memberships: services.repositories.memberships,
        actors: services.repositories.actors,
        ledger: services.ledger,
      },
      tx,
      workspace.id,
      viewer,
      'viewer',
      'test-setup',
      new Date(),
    );
  });

  adminBrowser = await new Browser().signIn(OWNER.email, OWNER.password);
  viewerBrowser = await new Browser().signIn(VIEWER.email, VIEWER.password);
});

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
});

function owner(): Browser {
  return adminBrowser;
}

describe('agent administration', () => {
  it('rejects anonymous and non-admin callers', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/admin/agents.list' })).statusCode).toBe(
      401,
    );
    const viewer = viewerBrowser;
    const res = await viewer.get('/v1/admin/agents.list');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('creates an agent with its own actor and records the event', async () => {
    const admin = owner();
    const res = await admin.post('/v1/admin/agents.create', {
      name: 'Claude Code - Mac mini',
      client_type: 'claude-code',
      trust_tier: 'propose',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { agent } = AgentResponse.parse(res.json());
    expect(agent).toMatchObject({
      name: 'Claude Code - Mac mini',
      trust_tier: 'propose',
      status: 'active',
      active_credentials: 0,
    });

    const events = await services.repositories.events.listAfter(agent.workspace_id, 0, 100);
    const created = events.find((e) => e.eventType === 'agent.created');
    expect(created?.metadata).toMatchObject({ actor_id: agent.actor_id, trust_tier: 'propose' });
    expect((await services.ledger.verify(agent.workspace_id)).ok).toBe(true);
  });

  it('refuses a duplicate name and lists agents', async () => {
    const admin = owner();
    const dup = await admin.post('/v1/admin/agents.create', { name: 'Claude Code - Mac mini' });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().code).toBe('VALIDATION_ERROR');
    const list = AgentsResponse.parse((await admin.get('/v1/admin/agents.list')).json());
    expect(list.agents.map((a) => a.name)).toContain('Claude Code - Mac mini');
  });

  it('validates the body', async () => {
    const admin = owner();
    const res = await admin.post('/v1/admin/agents.create', { name: '', trust_tier: 'superuser' });
    expect(res.statusCode).toBe(400);
  });
});

describe('credentials', () => {
  async function newAgent(name: string) {
    const admin = owner();
    const res = await admin.post('/v1/admin/agents.create', { name });
    return { admin, agent: AgentResponse.parse(res.json()).agent };
  }

  it('issues a token once, authenticates it and never stores it', async () => {
    const { admin, agent } = await newAgent('Issuer test');
    const res = await admin.post('/v1/admin/agents.credentials.issue', {
      agent_id: agent.id,
      label: 'laptop',
    });
    expect(res.statusCode, res.body).toBe(200);
    const issued = IssueCredentialResponse.parse(res.json());
    expect(issued.token).toMatch(/^knv_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/);
    expect(issued.token).toContain(`_${issued.credential.token_prefix}_`);

    const resolved = await services.agents.authenticate(issued.token);
    expect(resolved?.agent.id).toBe(agent.id);
    expect(resolved?.credential.label).toBe('laptop');

    const stored = await services.repositories.credentials.findById(issued.credential.id);
    expect(stored?.tokenHash).not.toContain(issued.token);
    expect(stored?.lastUsedAt).not.toBeNull();

    const list = CredentialsResponse.parse(
      (await admin.get(`/v1/admin/agents.credentials?agent_id=${agent.id}`)).json(),
    );
    expect(list.credentials).toHaveLength(1);
    expect(JSON.stringify(list.credentials)).not.toContain(issued.token);

    const events = await services.repositories.events.listAfter(agent.workspace_id, 0, 200);
    const issuedEvent = events.find((e) => e.eventType === 'agent.credential_issued');
    expect(JSON.stringify(issuedEvent?.metadata)).not.toContain(issued.token);
  });

  it('rejects a revoked token immediately', async () => {
    const { admin, agent } = await newAgent('Revoke test');
    const issued = IssueCredentialResponse.parse(
      (await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id })).json(),
    );
    expect(await services.agents.authenticate(issued.token)).not.toBeNull();
    const revoke = await admin.post('/v1/admin/agents.credentials.revoke', {
      credential_id: issued.credential.id,
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(await services.agents.authenticate(issued.token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { admin, agent } = await newAgent('Expiry test');
    const issued = IssueCredentialResponse.parse(
      (
        await admin.post('/v1/admin/agents.credentials.issue', {
          agent_id: agent.id,
          expires_in_days: 1,
        })
      ).json(),
    );
    expect(await services.agents.authenticate(issued.token)).not.toBeNull();
    await services.uow.run((tx) =>
      services.repositories.credentials.revoke(tx, issued.credential.id, new Date()),
    );
    expect(await services.agents.authenticate(issued.token)).toBeNull();
  });

  it('revokes every credential when the agent is disabled', async () => {
    const { admin, agent } = await newAgent('Disable test');
    const issued = IssueCredentialResponse.parse(
      (await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id })).json(),
    );
    const update = await admin.post('/v1/admin/agents.update', {
      agent_id: agent.id,
      status: 'disabled',
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(AgentResponse.parse(update.json()).agent.status).toBe('disabled');
    expect(await services.agents.authenticate(issued.token)).toBeNull();
    const reissue = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id });
    expect(reissue.statusCode).toBe(400);
  });

  it('rejects malformed and unknown tokens', async () => {
    expect(await services.agents.authenticate('not-a-token')).toBeNull();
    expect(await services.agents.authenticate('knv_abc_def')).toBeNull();
  });

  it('does not let an agent token reach agent administration', async () => {
    const { admin, agent } = await newAgent('Privilege test');
    const issued = IssueCredentialResponse.parse(
      (await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id })).json(),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/agents.list',
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });
});

describe('workspace scoping', () => {
  it('refuses a workspace the user does not belong to', async () => {
    const admin = owner();
    const other = await services.workspaces.create({
      slug: 'other',
      name: 'Other',
      requestId: 'r',
    });
    const res = await admin.request({
      method: 'GET',
      url: '/v1/admin/agents.list',
      headers: { [WORKSPACE_HEADER]: other.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid workspace header', async () => {
    const admin = owner();
    const res = await admin.request({
      method: 'GET',
      url: '/v1/admin/agents.list',
      headers: { [WORKSPACE_HEADER]: 'not-an-id' },
    });
    expect(res.statusCode).toBe(400);
  });
});
