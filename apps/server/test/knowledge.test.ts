import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KnowledgeListResponse, KnowledgeResponse, RevisionsResponse } from '@knoverge/contracts';
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

describe('changing an item', () => {
  const write = async (body: Record<string, unknown>) => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Backup policy',
      body: 'Nightly, kept for thirty days.',
      type: 'decision',
      categories: ['architecture'],
      ...body,
    });
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  };

  it('refuses an update based on a revision that is no longer current', async () => {
    const item = await write({ title: 'Concurrency' });
    const stale = {
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
    };

    const first = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      ...stale,
      body: 'The first edit wins.',
    });
    expect(first.statusCode, first.body).toBe(200);

    // The second caller read the same revision and would overwrite the first.
    const second = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      ...stale,
      body: 'The second edit must not silently win.',
    });
    expect(second.statusCode).toBe(409);
    const error = second.json();
    expect(error.code).toBe('REVISION_CONFLICT');
    // The answer carries what the caller has to re-read.
    expect(error.object_ids.current_revision_id).not.toBe(item.current_revision_id);
    expect(error.object_ids.current_content_hash).toBeTruthy();
  });

  it('writes a new revision and keeps the old one readable', async () => {
    const item = await write({ title: 'History' });
    const updated = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
          body: 'Nightly, kept for ninety days.',
        })
      ).json(),
    ).item;
    expect(updated.revision_number).toBe(2);
    expect(updated.content_hash).not.toBe(item.content_hash);

    const history = RevisionsResponse.parse(
      (await admin.get(`/v1/knowledge.revisions?item_id=${item.id}`)).json(),
    );
    expect(history.revisions.map((r) => r.revision_number)).toEqual([2, 1]);
    expect(history.revisions.map((r) => r.change_kind)).toEqual(['update', 'create']);
    // Two revisions, two commits.
    expect(history.revisions[0]!.git_commit).not.toBe(history.revisions[1]!.git_commit);
  });

  it('records a metadata-only change as its own revision', async () => {
    const item = await write({ title: 'Metadata' });
    const updated = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
          tags: ['backups'],
        })
      ).json(),
    ).item;
    // The text did not change, so the content hash did not move — and it is
    // still a new revision and a new commit.
    expect(updated.content_hash).toBe(item.content_hash);
    expect(updated.revision_number).toBe(2);
    const history = RevisionsResponse.parse(
      (await admin.get(`/v1/knowledge.revisions?item_id=${item.id}`)).json(),
    );
    expect(history.revisions[0]!.change_kind).toBe('metadata');
    expect(history.revisions[0]!.frontmatter_hash).not.toBe(history.revisions[1]!.frontmatter_hash);
  });

  it('moves the file when the primary category changes', async () => {
    expect((await admin.post('/v1/admin/taxonomy.create', { name: 'Operations' })).statusCode).toBe(
      200,
    );
    const item = await write({ title: 'Relocation' });
    const moved = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
          categories: ['operations'],
        })
      ).json(),
    ).item;
    expect(moved.markdown_path).toBe('knowledge/operations/relocation.md');

    const repository = join(dataDir, 'repositories', item.workspace_id);
    // The file is where it moved to, and not where it was.
    await expect(readFile(join(repository, moved.markdown_path), 'utf8')).resolves.toContain(
      'Relocation',
    );
    await expect(readFile(join(repository, item.markdown_path), 'utf8')).rejects.toThrow();
    // One commit, naming both paths.
    const show = await gitIn(repository, ['show', '--name-status', '--format=%s', 'HEAD']);
    expect(show).toContain('move(decision): Relocation');
    expect(show).toContain(item.markdown_path);
    expect(show).toContain(moved.markdown_path);
  });

  it('deletes logically and restores from history', async () => {
    const item = await write({ title: 'Ephemeral' });
    const repository = join(dataDir, 'repositories', item.workspace_id);

    const deleted = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.delete', {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
        })
      ).json(),
    ).item;
    expect(deleted.status).toBe('deleted');
    // Gone from the working tree, still in the history.
    await expect(readFile(join(repository, item.markdown_path), 'utf8')).rejects.toThrow();
    expect(await gitIn(repository, ['show', `HEAD~1:${item.markdown_path}`])).toContain(
      'Nightly, kept for thirty days.',
    );
    // And gone from the list a reader sees.
    const list = KnowledgeListResponse.parse((await admin.get('/v1/knowledge.list')).json());
    expect(list.items.find((i) => i.id === item.id)?.status).toBe('deleted');

    const restored = KnowledgeResponse.parse(
      (await admin.post('/v1/admin/knowledge.restore', { item_id: item.id })).json(),
    ).item;
    expect(restored.status).toBe('active');
    expect(restored.body).toContain('Nightly, kept for thirty days.');
    await expect(readFile(join(repository, restored.markdown_path), 'utf8')).resolves.toContain(
      'Ephemeral',
    );
  });
});

describe('sources and relations', () => {
  it('records a source, makes the item source-backed, and mirrors it into the file', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Backed by a spec',
      body: 'The specification says so.',
      type: 'fact',
      sources: [{ type: 'web_url', uri: 'https://example.com/spec', role: 'primary' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = KnowledgeResponse.parse(res.json()).item;
    // A source somebody else can check is what makes it evidence.
    expect(item.evidence_state).toBe('source_backed');
    expect(item.sources).toEqual([
      { type: 'web_url', uri: 'https://example.com/spec', role: 'primary' },
    ]);

    const file = await readFile(
      join(dataDir, 'repositories', item.workspace_id, item.markdown_path),
      'utf8',
    );
    expect(file).toContain('https://example.com/spec');
  });

  it('leaves a source with no locator as an assertion, not evidence', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Somebody said so',
      body: 'Heard in a meeting.',
      type: 'observation',
      sources: [{ type: 'human_input', role: 'primary' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(KnowledgeResponse.parse(res.json()).item.evidence_state).toBe('none');
  });

  it('relates two items, and replaces the whole list on update', async () => {
    const one = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'The older decision',
          body: 'What we decided first.',
          type: 'decision',
        })
      ).json(),
    ).item;
    const two = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'The newer decision',
          body: 'What we decided instead.',
          type: 'decision',
          relations: [{ type: 'supersedes', target: one.id }],
        })
      ).json(),
    ).item;
    expect(two.relations).toEqual([{ type: 'supersedes', target: one.id }]);

    // Replaced whole, like tags: dropping it from the list removes it.
    const updated = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: two.id,
          base_revision_id: two.current_revision_id,
          base_content_hash: two.content_hash,
          relations: [],
        })
      ).json(),
    ).item;
    expect(updated.relations).toEqual([]);
    // And the file agrees, because the frontmatter is the portable copy.
    const file = await readFile(
      join(dataDir, 'repositories', updated.workspace_id, updated.markdown_path),
      'utf8',
    );
    expect(file).not.toContain('supersedes');
  });

  it('refuses a relation to an item that does not exist', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Points at nothing',
      body: 'Body.',
      type: 'fact',
      relations: [{ type: 'relates_to', target: 'kn_01M2ZZZZZZZZZZZZZZZZZZZZZZ' }],
    });
    // A mistyped id is the caller's mistake, so it reads as one rather than as
    // an internal error on the way out of a foreign key.
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().message).toMatch(/no knowledge item/);
  });

  it('refuses an item that relates to itself', async () => {
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Self referential',
          body: 'Body.',
          type: 'fact',
        })
      ).json(),
    ).item;
    const res = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      relations: [{ type: 'relates_to', target: item.id }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/relate to itself/);
  });
});
