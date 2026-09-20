import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KnowledgeListResponse, KnowledgeResponse } from '@knoverge/contracts';
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
let admin: Browser;

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

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    // Each suite writes its workspace repositories to a directory of its own.
    dataDir: dataDir,
    ledgerKey: parseLedgerKey('d4'.repeat(32)),
    tokenPepper: 'e5'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'f6'.repeat(32), cookieSecure: false },
  });
  admin = new Browser();
  admin.csrf = ((await admin.get('/v1/auth/csrf')).json() as { token: string }).token;
  const res = await admin.post('/v1/bootstrap', {
    ...OWNER,
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function gitIn(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout;
}

describe('creating a knowledge item', () => {
  it('writes the file, the revision and the event as one operation', async () => {
    expect(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'Architecture' })).statusCode,
    ).toBe(200);

    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Authentication strategy',
      body: 'Passwordless login uses a six-digit email code.\n\nGoogle OAuth is supported.\n',
      type: 'decision',
      categories: ['architecture'],
      tags: ['auth', 'auth'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = KnowledgeResponse.parse(res.json()).item;
    expect(item.slug).toBe('authentication-strategy');
    expect(item.markdown_path).toBe('knowledge/architecture/authentication-strategy.md');
    expect(item.revision_number).toBe(1);
    // A person wrote it, so it is reviewed by construction.
    expect(item.review_state).toBe('human_reviewed');
    // The same tag twice is one tag.
    expect(item.tags).toEqual(['auth']);

    // The file is in the repository, and it is the file the item describes.
    const repository = join(dataDir, 'repositories', item.workspace_id);
    const file = await readFile(join(repository, item.markdown_path), 'utf8');
    expect(file).toContain(`id: ${item.id}`);
    expect(file).toContain('title: Authentication strategy');
    expect(file).toContain('Passwordless login uses a six-digit email code.');

    // One commit, carrying what recovery needs to rebuild the row.
    const log = await gitIn(repository, ['log', '-1', '--format=%s%n%b']);
    expect(log).toContain('create(decision): Authentication strategy');
    expect(log).toContain(`Knoverge-Change: ${item.id}@${item.current_revision_id} create`);
  });

  it('reads the item back with its body, and lists it without one', async () => {
    const list = KnowledgeListResponse.parse((await admin.get('/v1/knowledge.list')).json());
    expect(list.items).toHaveLength(1);
    const listed = list.items[0]!;
    expect(listed.title).toBe('Authentication strategy');
    expect(listed).not.toHaveProperty('body');

    const got = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${listed.id}`)).json(),
    );
    expect(got.item.body).toContain('Google OAuth is supported.');
    expect(got.item.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives a second item with the same title a slug of its own', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Authentication strategy',
      body: 'A different decision with the same name.',
      type: 'decision',
      categories: ['architecture'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = KnowledgeResponse.parse(res.json()).item;
    expect(item.slug).not.toBe('authentication-strategy');
    expect(item.markdown_path).toMatch(/^knowledge\/architecture\/authentication-strategy-/);
  });

  it('puts an item with no category under _uncategorised', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Loose note',
      body: 'Filed nowhere in particular.',
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(KnowledgeResponse.parse(res.json()).item.markdown_path).toBe(
      'knowledge/_uncategorised/loose-note.md',
    );
  });

  it('refuses an unknown or archived category', async () => {
    const missing = await admin.post('/v1/admin/knowledge.create', {
      title: 'Nowhere',
      body: 'Body.',
      type: 'fact',
      categories: ['no-such-category'],
    });
    expect(missing.statusCode).toBe(404);

    const branch = await admin.post('/v1/admin/taxonomy.create', { name: 'Retired' });
    const branchId = (branch.json() as { category: { id: string } }).category.id;
    expect(
      (await admin.post('/v1/admin/taxonomy.archive', { category_id: branchId })).statusCode,
    ).toBe(200);
    const archived = await admin.post('/v1/admin/knowledge.create', {
      title: 'Into the archive',
      body: 'Body.',
      type: 'fact',
      categories: ['retired'],
    });
    expect(archived.statusCode).toBe(409);
  });

  it('refuses an agent, because an agent proposes', async () => {
    // Rule 14: an agent write needs a policy rule that allows it directly, and
    // that decision is the review workflow of Milestone 3. A trusted agent
    // holds knowledge.write, so the permission alone must not be enough.
    const agent = (
      await admin.post('/v1/admin/agents.create', { name: 'Writer', trust_tier: 'trusted' })
    ).json() as { agent: { id: string } };
    const issued = (
      await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.agent.id })
    ).json() as { token: string };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/knowledge.create',
      headers: { authorization: `Bearer ${issued.token}` },
      payload: { title: 'By an agent', body: 'Body.', type: 'fact' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });
});
