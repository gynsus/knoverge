import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  TERMS_VERSION,
  CreateWorkspaceResponse,
  MeResponse,
  MembersResponse,
  WorkspaceResponse,
  WorkspacesResponse,
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
let dataDir: string;
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
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    // Each suite writes its workspace repositories to a directory of its own.
    dataDir: dataDir,
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
    accepted_terms_version: TERMS_VERSION,
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
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

  it('resets a member password, ending their sessions', async () => {
    const members = MembersResponse.parse(
      (await owner.get('/v1/admin/members.list')).json(),
    ).members;
    const member = members.find((m) => m.email === MEMBER.email)!;
    const browser = await new Browser().signIn(MEMBER.email, MEMBER.password);
    expect((await browser.get('/v1/taxonomy.list')).statusCode).toBe(200);

    const fresh = 'a whole new passphrase';
    const res = await owner.post('/v1/admin/members.reset_password', {
      user_id: member.user_id,
      new_password: fresh,
    });
    expect(res.statusCode, res.body).toBe(200);

    // The session opened with the old password is gone, and the old password
    // no longer works.
    expect((await browser.get('/v1/taxonomy.list')).statusCode).toBe(401);
    await expect(new Browser().signIn(MEMBER.email, MEMBER.password)).rejects.toThrow();
    const again = await new Browser().signIn(MEMBER.email, fresh);
    expect((await again.get('/v1/taxonomy.list')).statusCode).toBe(200);
    // Put it back, so the tests after this one still know the password.
    expect(
      (
        await owner.post('/v1/admin/members.reset_password', {
          user_id: member.user_id,
          new_password: MEMBER.password,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses to reset the password of somebody whose role outranks yours', async () => {
    const members = MembersResponse.parse(
      (await owner.get('/v1/admin/members.list')).json(),
    ).members;
    const ownerMember = members.find((m) => m.email !== MEMBER.email)!;
    const member = members.find((m) => m.email === MEMBER.email)!;

    // Promote the member to admin, then have them try it on the owner. Without
    // the role rule this endpoint is a promotion from admin to owner that no
    // role change records.
    await owner.post('/v1/admin/members.update', { user_id: member.user_id, role: 'admin' });
    const asAdmin = await new Browser().signIn(MEMBER.email, MEMBER.password);
    const res = await asAdmin.post('/v1/admin/members.reset_password', {
      user_id: ownerMember.user_id,
      new_password: 'this should not work at all',
    });
    expect(res.statusCode, res.body).toBe(403);

    // And not on themselves either: that is what the settings page is for, and
    // it checks the current password.
    const self = await asAdmin.post('/v1/admin/members.reset_password', {
      user_id: member.user_id,
      new_password: 'nor should this one work',
    });
    expect(self.statusCode, self.body).toBe(403);
    await owner.post('/v1/admin/members.update', { user_id: member.user_id, role: 'reviewer' });
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

/**
 * Creating a workspace is done by accounts of its own rather than by `owner`,
 * because a second membership changes what every later request from that
 * browser needs: with more than one workspace the selection header stops being
 * optional.
 */
describe('creating a workspace', () => {
  const BUILDER = { email: 'builder@example.com', password: 'a long enough passphrase' };
  const WATCHER = { email: 'watcher@example.com', password: 'another long passphrase' };

  it('creates a workspace with the caller as its owner', async () => {
    // An owner, because workspace.admin is the owner's permission: the admin
    // role manages agents and policy but not the workspace itself.
    const added = await owner.post('/v1/admin/members.add', {
      email: BUILDER.email,
      role: 'owner',
      display_name: 'Builder',
      initial_password: BUILDER.password,
    });
    expect(added.statusCode, added.body).toBe(200);

    const builder = await new Browser().signIn(BUILDER.email, BUILDER.password);
    const res = await builder.post('/v1/admin/workspace.create', {
      slug: 'second',
      name: 'Second Workspace',
      description: 'Made by an administrator of the first.',
      default_language: 'ru',
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = CreateWorkspaceResponse.parse(res.json()).workspace;
    expect(created).toMatchObject({
      slug: 'second',
      name: 'Second Workspace',
      default_language: 'ru',
      role: 'owner',
    });

    // The session sees the membership, so the interface can switch into it.
    const me = MeResponse.parse((await builder.get('/v1/auth/me')).json());
    expect(me.memberships.map((m) => m.workspace_slug).sort()).toEqual(['personal', 'second']);
    expect(me.memberships.find((m) => m.workspace_slug === 'second')?.role).toBe('owner');

    // With two memberships the workspace has to be named.
    expect((await builder.get('/v1/workspace.get')).statusCode).toBe(400);
    const scoped = await builder.request({
      method: 'GET',
      url: '/v1/workspace.get',
      headers: { 'x-knoverge-workspace': created.id },
    });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(WorkspaceResponse.parse(scoped.json()).permissions).toContain('workspace.admin');

    // A new chain: workspace.created first, attributed across the two
    // workspaces, then the owner's membership.
    const events = await services.repositories.events.listAfter(created.id, 0, 200);
    expect(events.map((e) => e.eventType)).toEqual(['workspace.created', 'membership.created']);
    expect(events[0]?.metadata).toMatchObject({ slug: 'second' });
    expect(events[0]?.metadata).toHaveProperty('created_by_actor_id');
    expect(events[0]?.metadata).toHaveProperty('created_by_workspace_id');
    expect((await services.ledger.verify(created.id)).ok).toBe(true);
  });

  it('lists the workspaces somebody belongs to, with what is in them', async () => {
    const builder = await new Browser().signIn(BUILDER.email, BUILDER.password);
    const res = await builder.get('/v1/workspaces.list');
    expect(res.statusCode, res.body).toBe(200);
    const listed = WorkspacesResponse.parse(res.json()).workspaces;

    // Their own memberships and nothing else. A workspace they do not belong
    // to is not theirs to know about.
    expect(listed.map((w) => w.slug).sort()).toEqual(['personal', 'second']);
    const second = listed.find((w) => w.slug === 'second')!;
    expect(second).toMatchObject({
      name: 'Second Workspace',
      role: 'owner',
      item_count: 0,
      agent_count: 0,
    });
    // What they may do there, decided by the authorisation service rather
    // than guessed from the role, so an interface choosing what to offer for
    // a workspace somebody is not in does not carry a second copy of the
    // policy.
    expect(second.permissions).toContain('workspace.admin');
    expect(listed.find((w) => w.slug === 'personal')?.permissions).toContain('workspace.admin');
    // A workspace that has only just been created still has a ledger, so it
    // has an activity time; a null here would mean nothing was recorded.
    expect(second.last_activity_at).not.toBeNull();

    // The counts are grouped in one query across every workspace, so the risk
    // is a count landing against the wrong one. An agent in the first
    // workspace must show there and nowhere else.
    const agent = await owner.post('/v1/admin/agents.create', { name: 'counted-agent' });
    expect(agent.statusCode, agent.body).toBe(200);
    const after = WorkspacesResponse.parse(
      (await builder.get('/v1/workspaces.list')).json(),
    ).workspaces;
    expect(after.find((w) => w.slug === 'personal')?.agent_count).toBe(1);
    expect(after.find((w) => w.slug === 'second')?.agent_count).toBe(0);

    // It is a person's view of their own memberships, so it needs a session.
    expect((await new Browser().get('/v1/workspaces.list')).statusCode).toBe(401);
  });

  it('refuses a slug that is already taken', async () => {
    const builder = await new Browser().signIn(BUILDER.email, BUILDER.password);
    const res = await builder.post('/v1/admin/workspace.create', {
      slug: 'personal',
      name: 'Another Personal',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('refuses somebody who holds workspace.admin nowhere', async () => {
    // An administrator rather than a viewer: the role manages agents and
    // policy, and is still not enough to bring another workspace into being.
    const added = await owner.post('/v1/admin/members.add', {
      email: WATCHER.email,
      role: 'admin',
      display_name: 'Watcher',
      initial_password: WATCHER.password,
    });
    expect(added.statusCode, added.body).toBe(200);

    const watcher = await new Browser().signIn(WATCHER.email, WATCHER.password);
    const res = await watcher.post('/v1/admin/workspace.create', {
      slug: 'watchers-place',
      name: "Watcher's place",
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('refuses a caller with no session, which is every agent', async () => {
    const anonymous = new Browser();
    anonymous.csrf = ((await anonymous.get('/v1/auth/csrf')).json() as { token: string }).token;
    const res = await anonymous.post('/v1/admin/workspace.create', {
      slug: 'nobodys',
      name: 'Nobody',
    });
    expect(res.statusCode, res.body).toBe(401);
  });
});
