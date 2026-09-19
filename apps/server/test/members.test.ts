import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MembersResponse, WorkspaceResponse } from '@knoverge/contracts';
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

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };
const MEMBER = { email: 'member@example.com', password: 'another long passphrase here' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    ledgerKey: parseLedgerKey('3c'.repeat(32)),
    tokenPepper: '4d'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: '5e'.repeat(32), cookieSecure: false },
  });
  owner = new Browser();
  owner.csrf = ((await owner.get('/v1/auth/csrf')).json() as { token: string }).token;
  const res = await owner.post('/v1/bootstrap', {
    ...OWNER,
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('workspace settings', () => {
  it('reads and updates the workspace', async () => {
    const before = WorkspaceResponse.parse((await owner.get('/v1/workspace.get')).json());
    expect(before.workspace).toMatchObject({ slug: 'personal', name: 'Personal', role: 'owner' });

    const update = await owner.post('/v1/admin/workspace.update', {
      name: 'Personal Knowledge',
      description: 'Everything I want my agents to remember.',
      default_language: 'ru',
    });
    expect(update.statusCode, update.body).toBe(200);

    const after = WorkspaceResponse.parse((await owner.get('/v1/workspace.get')).json());
    expect(after.workspace).toMatchObject({
      name: 'Personal Knowledge',
      default_language: 'ru',
      slug: 'personal',
    });

    const events = await services.repositories.events.listAfter(after.workspace.id, 0, 200);
    expect(events.at(-1)).toMatchObject({
      eventType: 'workspace.updated',
      metadata: { changed: ['defaultLanguage', 'description', 'name'] },
    });
    expect((await services.ledger.verify(after.workspace.id)).ok).toBe(true);
  });

  it('validates the body', async () => {
    expect((await owner.post('/v1/admin/workspace.update', { name: '' })).statusCode).toBe(400);
    expect(
      (await owner.post('/v1/admin/workspace.update', { default_language: 'Russian' })).statusCode,
    ).toBe(400);
  });
});

describe('members', () => {
  it('creates an account for a new email and lists it', async () => {
    const res = await owner.post('/v1/admin/members.add', {
      email: MEMBER.email,
      role: 'reviewer',
      display_name: 'Member',
      initial_password: MEMBER.password,
    });
    expect(res.statusCode, res.body).toBe(200);
    const members = MembersResponse.parse(res.json()).members;
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.email === MEMBER.email)).toMatchObject({
      role: 'reviewer',
      display_name: 'Member',
      status: 'active',
      last_login_at: null,
    });

    const browser = await new Browser().signIn(MEMBER.email, MEMBER.password);
    expect((await browser.get('/v1/taxonomy.list')).statusCode).toBe(200);
    // A reviewer may not administer the workspace.
    expect((await browser.get('/v1/admin/members.list')).statusCode).toBe(403);
  });

  it('refuses a new email without an initial password and a duplicate member', async () => {
    const missing = await owner.post('/v1/admin/members.add', { email: 'nobody@example.com' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/initial password/);

    const duplicate = await owner.post('/v1/admin/members.add', {
      email: MEMBER.email,
      initial_password: MEMBER.password,
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().message).toMatch(/already a member/);
  });

  it('changes a role and then removes the member', async () => {
    const members = MembersResponse.parse(
      (await owner.get('/v1/admin/members.list')).json(),
    ).members;
    const member = members.find((m) => m.email === MEMBER.email)!;

    const promote = await owner.post('/v1/admin/members.update', {
      user_id: member.user_id,
      role: 'admin',
    });
    expect(promote.statusCode, promote.body).toBe(200);
    const promoted = MembersResponse.parse(
      (await owner.get('/v1/admin/members.list')).json(),
    ).members;
    expect(promoted.find((m) => m.user_id === member.user_id)?.role).toBe('admin');

    const removed = await owner.post('/v1/admin/members.remove', { user_id: member.user_id });
    expect(removed.statusCode, removed.body).toBe(200);
    const after = MembersResponse.parse((await owner.get('/v1/admin/members.list')).json()).members;
    expect(after.map((m) => m.email)).not.toContain(MEMBER.email);

    // The account still exists but reaches no workspace.
    const browser = await new Browser().signIn(MEMBER.email, MEMBER.password);
    expect((await browser.get('/v1/taxonomy.list')).statusCode).toBe(403);
  });

  it('keeps at least one owner', async () => {
    const members = MembersResponse.parse(
      (await owner.get('/v1/admin/members.list')).json(),
    ).members;
    const theOwner = members.find((m) => m.role === 'owner')!;
    const demote = await owner.post('/v1/admin/members.update', {
      user_id: theOwner.user_id,
      role: 'reviewer',
    });
    expect(demote.statusCode).toBe(400);
    expect(demote.json().message).toMatch(/at least one owner/);
    const remove = await owner.post('/v1/admin/members.remove', { user_id: theOwner.user_id });
    expect(remove.statusCode).toBe(400);
  });

  it('reports an unknown membership', async () => {
    const res = await owner.post('/v1/admin/members.remove', {
      user_id: 'usr_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    });
    expect(res.statusCode).toBe(404);
  });
});
