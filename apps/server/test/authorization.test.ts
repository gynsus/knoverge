import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AgentResponse,
  IssueCredentialResponse,
  MembersResponse,
  type WorkspaceId,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
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
let owner: Browser;
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

  async signIn(email: string, password: string) {
    this.csrf = ((await this.get('/v1/auth/csrf')).json() as { token: string }).token;
    const res = await this.post('/v1/auth/login', { email, password });
    expect(res.statusCode, res.body).toBe(200);
    return this;
  }
}

function asAgent(token: string, opts: InjectOptions & { url: string }) {
  return app.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
}

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };
const ADMIN = { email: 'second@example.com', password: 'seven purple lanterns drift' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    ledgerKey: parseLedgerKey('7a'.repeat(32)),
    tokenPepper: '8b'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: '9c'.repeat(32), cookieSecure: false },
    rateLimit: { max: 10_000 },
  });
  owner = new Browser();
  owner.csrf = ((await owner.get('/v1/auth/csrf')).json() as { token: string }).token;
  expect(
    (
      await owner.post('/v1/bootstrap', {
        ...OWNER,
        display_name: 'Owner',
        workspace: { slug: 'personal', name: 'Personal' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await owner.post('/v1/admin/members.add', {
        email: ADMIN.email,
        role: 'admin',
        display_name: 'Second',
        initial_password: ADMIN.password,
      })
    ).statusCode,
  ).toBe(200);
  admin = await new Browser().signIn(ADMIN.email, ADMIN.password);
  workspaceId = (await services.repositories.workspaces.list())[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('privilege escalation is refused', () => {
  it('an admin cannot grant itself an action it does not hold', async () => {
    const members = MembersResponse.parse((await owner.get('/v1/admin/members.list')).json());
    const self = members.members.find((m) => m.email === ADMIN.email)!;

    const res = await admin.post('/v1/admin/permissions.grant', {
      actor_id: self.actor_id,
      action: 'workspace.admin',
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toMatch(/do not hold/);
    expect(
      (await admin.post('/v1/admin/workspace.update', { name: 'Taken over' })).statusCode,
    ).toBe(403);
  });

  it('an admin cannot route the same escalation through an agent it creates', async () => {
    // The whole chain that used to end in a workspace takeover.
    const created = await admin.post('/v1/admin/agents.create', { name: 'Helper' });
    expect(created.statusCode, created.body).toBe(200);
    const agent = AgentResponse.parse(created.json()).agent;

    const granted = await admin.post('/v1/admin/permissions.grant', {
      actor_id: agent.actor_id,
      action: 'workspace.admin',
    });
    expect(granted.statusCode, granted.body).toBe(403);

    const issued = IssueCredentialResponse.parse(
      (await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id })).json(),
    );
    expect(
      (await asAgent(issued.token, { method: 'GET', url: '/v1/admin/members.list' })).statusCode,
    ).toBe(403);
    expect(
      (
        await asAgent(issued.token, {
          method: 'POST',
          url: '/v1/admin/workspace.update',
          payload: { name: 'Taken over by an agent' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('an owner cannot give an agent an action reserved for people', async () => {
    const created = await owner.post('/v1/admin/agents.create', { name: 'Would-be administrator' });
    const agent = AgentResponse.parse(created.json()).agent;
    for (const action of ['workspace.admin', 'policy.manage', 'agent.manage'] as const) {
      const res = await owner.post('/v1/admin/permissions.grant', {
        actor_id: agent.actor_id,
        action,
      });
      expect(res.statusCode, `${action}: ${res.body}`).toBe(403);
      expect(res.json().message).toMatch(/cannot be granted to an agent/);
    }
  });

  it('an owner may still grant what it holds, including to an agent', async () => {
    const created = await owner.post('/v1/admin/agents.create', { name: 'Curator' });
    const agent = AgentResponse.parse(created.json()).agent;
    const res = await owner.post('/v1/admin/permissions.grant', {
      actor_id: agent.actor_id,
      action: 'taxonomy.manage',
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a deny grant needs no matching privilege, so access can always be narrowed', async () => {
    const members = MembersResponse.parse((await owner.get('/v1/admin/members.list')).json());
    const self = members.members.find((m) => m.email === ADMIN.email)!;
    const res = await admin.post('/v1/admin/permissions.grant', {
      actor_id: self.actor_id,
      action: 'workspace.admin',
      effect: 'deny',
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses an actor from another workspace', async () => {
    const other = await services.workspaces.create({
      slug: 'other',
      name: 'Other',
      requestId: 'r',
    });
    const foreign = await services.repositories.actors.findSystemActor(other.id);
    const res = await owner.post('/v1/admin/permissions.grant', {
      actor_id: foreign!.id,
      action: 'taxonomy.manage',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('provenance headers are telemetry, not authority', () => {
  it('accepts an overlong header instead of failing the write', async () => {
    const res = await owner.request({
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'Header probe' },
      headers: { 'x-knoverge-client': 'c'.repeat(200) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const events = await services.repositories.events.listAfter(workspaceId, 0, 1000);
    const last = events.at(-1)!;
    expect(last.client).toHaveLength(64);
  });

  it('strips control characters and drops an empty header', async () => {
    const res = await owner.request({
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'Control probe' },
      headers: { 'x-knoverge-client': 'claude\tcode', 'x-knoverge-model': '   ' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const events = await services.repositories.events.listAfter(workspaceId, 0, 1000);
    const last = events.at(-1)!;
    expect(last.client).toBe('claudecode');
    expect(last.model).toBeNull();
  });

  it('records the real session of a signed-in person, not the header', async () => {
    const me = (await owner.get('/v1/auth/me')).json() as { session: { id: string } };
    const res = await owner.request({
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      payload: { name: 'Session probe' },
      headers: { 'x-knoverge-session-id': 'sess_forged_by_the_caller' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const events = await services.repositories.events.listAfter(workspaceId, 0, 1000);
    expect(events.at(-1)!.sessionId).toBe(me.session.id);
  });
});

describe('sign-in failures are indistinguishable', () => {
  it('reports the same code for an unknown, a wrong and a locked account', async () => {
    const attempt = async (email: string, password: string) => {
      const b = new Browser();
      b.csrf = ((await b.get('/v1/auth/csrf')).json() as { token: string }).token;
      return b.post('/v1/auth/login', { email, password });
    };
    const unknown = await attempt('nobody@example.com', 'whatever whatever');
    const wrong = await attempt(OWNER.email, 'not the password');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());

    // Lock an account outright, then check it still looks like a wrong password.
    const locked = await services.users.findByEmail(ADMIN.email);
    await services.uow.run((tx) =>
      services.repositories.users.recordLoginFailure(
        tx,
        locked!.id,
        10,
        new Date(Date.now() + 60_000),
      ),
    );
    const afterLock = await attempt(ADMIN.email, ADMIN.password);
    expect(afterLock.statusCode).toBe(401);
    expect(afterLock.json()).toEqual(wrong.json());
  });
});

describe('rate limiting', () => {
  it('applies a per-actor budget to every route', async () => {
    const limited = await buildApp({
      version: 'test',
      probes: { database: async () => ok, dataDir: async () => ok },
      services,
      security: { sessionSecret: '9c'.repeat(32), cookieSecure: false },
      rateLimit: { max: 3, timeWindow: '1 minute' },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push((await limited.inject({ method: 'GET', url: '/v1/auth/status' })).statusCode);
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      const body = await limited.inject({ method: 'GET', url: '/v1/auth/status' });
      expect(body.json().code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
