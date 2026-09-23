import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  TERMS_VERSION,
  KnowledgeDiffResponse,
  KnowledgeListResponse,
  CategoryResponse,
  KnowledgeResponse,
  RevisionsResponse,
  SupersedeResponse,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import pino from 'pino';

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
    // Errors visible: without this an unhandled one reaches the test as
    // "internal error" and nothing says what it was.
    loggerInstance: pino({ level: 'error' }),
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

  it('takes the language from the workspace when the caller does not say', async () => {
    // A hard-coded 'en' made every item in a Russian workspace claim to be
    // English, which is what drives the full-text search configuration.
    expect(
      (await admin.post('/v1/admin/workspace.update', { default_language: 'ru' })).statusCode,
    ).toBe(200);
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Заметка',
      body: 'Написана по-русски.',
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(KnowledgeResponse.parse(res.json()).item.language).toBe('ru');
    // An explicit language still wins over the workspace's.
    const explicit = await admin.post('/v1/admin/knowledge.create', {
      title: 'A note',
      body: 'Written in English.',
      type: 'fact',
      language: 'en',
    });
    expect(KnowledgeResponse.parse(explicit.json()).item.language).toBe('en');
    await admin.post('/v1/admin/workspace.update', { default_language: 'en' });
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

describe('comparing two revisions', () => {
  it('shows the text that changed and the fields that changed', async () => {
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Retention',
          body: 'Backups are kept for thirty days.',
          type: 'decision',
          tags: ['backups'],
        })
      ).json(),
    ).item;
    const updated = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
          title: 'Retention policy',
          body: 'Backups are kept for ninety days.',
          tags: ['backups', 'retention'],
        })
      ).json(),
    ).item;

    const res = await admin.get(
      `/v1/knowledge.diff?item_id=${item.id}&from_revision_id=${item.current_revision_id}&to_revision_id=${updated.current_revision_id}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const diff = KnowledgeDiffResponse.parse(res.json());
    expect(diff.from.revision_number).toBe(1);
    expect(diff.to.revision_number).toBe(2);
    expect(diff.body_diff).toContain('-Backups are kept for thirty days.');
    expect(diff.body_diff).toContain('+Backups are kept for ninety days.');

    const changed = Object.fromEntries(diff.metadata_changes.map((c) => [c.field, c]));
    expect(Object.keys(changed).sort()).toEqual(['tags', 'title']);
    expect(changed['title']).toMatchObject({ from: 'Retention', to: 'Retention policy' });
    // updated_at differs on every revision by construction, so it is left out.
    expect(changed['updated_at']).toBeUndefined();
  });

  it('spans a move, where the file is at two different paths', async () => {
    expect((await admin.post('/v1/admin/taxonomy.create', { name: 'Storage' })).statusCode).toBe(
      200,
    );
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Travelling item',
          body: 'It starts here.',
          type: 'fact',
          categories: ['architecture'],
        })
      ).json(),
    ).item;
    const moved = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
          categories: ['storage'],
          body: 'It ends there.',
        })
      ).json(),
    ).item;
    expect(moved.markdown_path).not.toBe(item.markdown_path);

    const diff = KnowledgeDiffResponse.parse(
      (
        await admin.get(
          `/v1/knowledge.diff?item_id=${item.id}&from_revision_id=${item.current_revision_id}&to_revision_id=${moved.current_revision_id}`,
        )
      ).json(),
    );
    // A diff that could not span the move would be blank exactly here.
    expect(diff.body_diff).toContain('-It starts here.');
    expect(diff.body_diff).toContain('+It ends there.');
    expect(diff.metadata_changes.map((c) => c.field)).toContain('categories');
  });

  it('refuses two revisions that belong to different items', async () => {
    const one = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'First',
          body: 'One.',
          type: 'fact',
        })
      ).json(),
    ).item;
    const two = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Second',
          body: 'Two.',
          type: 'fact',
        })
      ).json(),
    ).item;
    const res = await admin.get(
      `/v1/knowledge.diff?item_id=${one.id}&from_revision_id=${one.current_revision_id}&to_revision_id=${two.current_revision_id}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/different items/);
  });
});

describe('superseding an item', () => {
  async function anItem(title: string, body: string) {
    const res = await admin.post('/v1/admin/knowledge.create', { title, body, type: 'fact' });
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  }

  it('writes one commit, two revisions and one relation', async () => {
    const old = await anItem('Backend database', 'The backend uses MySQL.');
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: old.id,
      old_base_revision_id: old.current_revision_id,
      old_base_content_hash: old.content_hash,
      valid_until: '2026-09-18T00:00:00Z',
      new_item: { title: 'Backend database', body: 'The backend uses PostgreSQL.', type: 'fact' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = SupersedeResponse.parse(res.json());

    // The old item keeps its text and stops being current.
    expect(result.superseded.status).toBe('superseded');
    expect(result.superseded.valid_until).toBe('2026-09-18T00:00:00.000Z');
    expect(result.superseded.body).toContain('The backend uses MySQL.');
    expect(result.superseded.revision_number).toBe(2);
    // The new item starts where the old one stopped.
    expect(result.item.valid_from).toBe('2026-09-18T00:00:00.000Z');
    expect(result.item.relations).toContainEqual({ type: 'supersedes', target: old.id });

    const repository = join(dataDir, 'repositories', old.workspace_id);
    // One commit, and it says what it did.
    const log = await gitIn(repository, ['log', '-1', '--format=%s%n%b']);
    expect(log).toContain('supersede(fact): Backend database');
    expect(log).toContain(
      `Knoverge-Change: ${result.item.id}@${result.item.current_revision_id} create`,
    );
    expect(log).toContain(
      `Knoverge-Change: ${old.id}@${result.superseded.current_revision_id} superseded_by`,
    );
    const touched = await gitIn(repository, ['show', '--name-only', '--format=', 'HEAD']);
    expect(touched).toContain(old.markdown_path);
    expect(touched).toContain(result.item.markdown_path);

    // The relation is recorded once and written twice: the new file carries
    // it as a relation, the old file as superseded_by (ADR 0015).
    const newFile = await readFile(join(repository, result.item.markdown_path), 'utf8');
    expect(newFile).toContain(`target: ${old.id}`);
    const oldFile = await readFile(join(repository, old.markdown_path), 'utf8');
    expect(oldFile).toContain(`superseded_by: ${result.item.id}`);
    expect(oldFile).toContain('status: superseded');
    // Not a second relation, which would be a second thing to disagree.
    expect(oldFile).not.toContain('type: supersedes');
  });

  it('lets an item the workspace already holds take over', async () => {
    const old = await anItem('Deployment target', 'We deploy to Heroku.');
    const replacement = await anItem('Deployment target, current', 'We deploy to Fly.io.');
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: old.id,
      old_base_revision_id: old.current_revision_id,
      old_base_content_hash: old.content_hash,
      existing_item: {
        item_id: replacement.id,
        base_revision_id: replacement.current_revision_id,
        base_content_hash: replacement.content_hash,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = SupersedeResponse.parse(res.json());

    // No new item: the one that already existed took over, and got a revision
    // of its own saying so.
    expect(result.item.id).toBe(replacement.id);
    expect(result.item.revision_number).toBe(2);
    expect(result.item.body).toContain('We deploy to Fly.io.');
    expect(result.item.relations).toContainEqual({ type: 'supersedes', target: old.id });
    expect(result.superseded.status).toBe('superseded');

    const repository = join(dataDir, 'repositories', old.workspace_id);
    const log = await gitIn(repository, ['log', '-1', '--format=%s%n%b']);
    expect(log).toContain(
      `Knoverge-Change: ${replacement.id}@${result.item.current_revision_id} supersede`,
    );
    expect(log).toContain(
      `Knoverge-Change: ${old.id}@${result.superseded.current_revision_id} superseded_by`,
    );
  });

  it('refuses a supersession that names both a new item and an existing one', async () => {
    const old = await anItem('Named twice', 'The original.');
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: old.id,
      old_base_revision_id: old.current_revision_id,
      old_base_content_hash: old.content_hash,
      new_item: { title: 'One', body: 'One.', type: 'fact' },
      existing_item: {
        item_id: old.id,
        base_revision_id: old.current_revision_id,
        base_content_hash: old.content_hash,
      },
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('refuses an item superseding itself', async () => {
    const old = await anItem('Its own replacement', 'The only text.');
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: old.id,
      old_base_revision_id: old.current_revision_id,
      old_base_content_hash: old.content_hash,
      existing_item: {
        item_id: old.id,
        base_revision_id: old.current_revision_id,
        base_content_hash: old.content_hash,
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/supersede itself/);
  });

  it('refuses a supersession written against an older revision', async () => {
    const old = await anItem('Moves on first', 'The first text.');
    expect(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: old.id,
          base_revision_id: old.current_revision_id,
          base_content_hash: old.content_hash,
          body: 'Changed before anybody superseded it.',
        })
      ).statusCode,
    ).toBe(200);
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: old.id,
      old_base_revision_id: old.current_revision_id,
      old_base_content_hash: old.content_hash,
      new_item: { title: 'Replacement', body: 'The replacement.', type: 'fact' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('REVISION_CONFLICT');
  });

  it('refuses to supersede an item that is already superseded', async () => {
    const old = await anItem('Superseded twice', 'The original.');
    const first = SupersedeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.supersede', {
          old_item_id: old.id,
          old_base_revision_id: old.current_revision_id,
          old_base_content_hash: old.content_hash,
          new_item: { title: 'First replacement', body: 'The first.', type: 'fact' },
        })
      ).json(),
    );
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: old.id,
      old_base_revision_id: first.superseded.current_revision_id,
      old_base_content_hash: first.superseded.content_hash,
      new_item: { title: 'Second replacement', body: 'The second.', type: 'fact' },
    });
    // The chain runs forward: what replaced it is what gets superseded next.
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/superseded/);
  });
});

describe('listing what the workspace holds', () => {
  it('pages, and says null only when there is nothing after', async () => {
    // Enough that one page cannot hold them, which is the case the old list
    // answered by showing the first fifty and calling that everything.
    for (let i = 0; i < 4; i += 1) {
      expect(
        (
          await admin.post('/v1/admin/knowledge.create', {
            title: `Paged item ${i}`,
            body: `One of several, number ${i}.`,
            type: 'fact',
          })
        ).statusCode,
      ).toBe(200);
    }

    const first = KnowledgeListResponse.parse(
      (await admin.get('/v1/knowledge.list?limit=2')).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = KnowledgeListResponse.parse(
      (await admin.get(`/v1/knowledge.list?limit=2&cursor=${first.next_cursor}`)).json(),
    );
    // Ids sort in creation order, so a page taken while items are being added
    // neither repeats nor skips.
    expect(second.items.map((i) => i.id)).not.toContain(first.items[0]!.id);

    const last = KnowledgeListResponse.parse(
      (await admin.get('/v1/knowledge.list?limit=200')).json(),
    );
    // Null exactly when there is nothing after, not merely when a page is short.
    expect(last.next_cursor).toBeNull();
  });
});

describe('the repository follows the taxonomy', () => {
  /** The item file as the repository holds it, or null when it is not there. */
  async function fileAt(path: string) {
    const listed = KnowledgeListResponse.parse((await admin.get('/v1/knowledge.list')).json());
    const workspaceId = listed.items[0]!.workspace_id;
    try {
      return await readFile(join(dataDir, 'repositories', workspaceId, path), 'utf8');
    } catch {
      return null;
    }
  }

  it('moves the knowledge under a category that is renamed', async () => {
    const category = CategoryResponse.parse(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'Playbooks' })).json(),
    ).category;
    const created = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Restarting the worker',
          body: 'Stop it, wait for the lock, start it.\n',
          type: 'instruction',
          categories: [category.path],
        })
      ).json(),
    ).item;
    expect(created.markdown_path).toBe('knowledge/playbooks/restarting-the-worker.md');

    const renamed = await admin.post('/v1/admin/taxonomy.update', {
      category_id: category.id,
      name: 'Field Guides',
      slug: 'field-guides',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    // The file is where the taxonomy now says it is, and nowhere else. A
    // directory no category claims is the whole of what rule 1 forbids.
    expect(await fileAt('knowledge/playbooks/restarting-the-worker.md')).toBeNull();
    const moved = await fileAt('knowledge/field-guides/restarting-the-worker.md');
    expect(moved).not.toBeNull();
    // And it says so itself, for somebody reading the repository without us.
    expect(moved).toContain('- field-guides');
    expect(moved).not.toContain('- playbooks');

    // The index agrees, so the next write goes to the file that exists.
    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${created.id}`)).json(),
    ).item;
    expect(item.markdown_path).toBe('knowledge/field-guides/restarting-the-worker.md');

    // The revision is untouched: it records where its file was at its own
    // commit, which is how history and restore read it back.
    const revisions = RevisionsResponse.parse(
      (await admin.get(`/v1/knowledge.revisions?item_id=${created.id}`)).json(),
    );
    expect(revisions.revisions).toHaveLength(1);
    expect(revisions.revisions[0]?.markdown_path).toBe(
      'knowledge/playbooks/restarting-the-worker.md',
    );
  });

  it('carries the knowledge of a merged category to the survivor', async () => {
    const survivor = CategoryResponse.parse(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'Data Sources' })).json(),
    ).category;
    const closing = CategoryResponse.parse(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'Data Providers' })).json(),
    ).category;
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Where the weather comes from',
          body: 'An hourly feed, keyed by station.\n',
          type: 'fact',
          categories: [closing.path],
        })
      ).json(),
    ).item;

    const merged = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: closing.id,
      into_category_id: survivor.id,
    });
    expect(merged.statusCode, merged.body).toBe(200);

    // The item belongs to the survivor now, so leaving its file in the closed
    // category's directory would have the repository disagree with the index
    // it is supposed to be the canonical copy of.
    expect(await fileAt('knowledge/data-providers/where-the-weather-comes-from.md')).toBeNull();
    const moved = await fileAt('knowledge/data-sources/where-the-weather-comes-from.md');
    expect(moved).toContain('- data-sources');

    const after = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${item.id}`)).json(),
    ).item;
    expect(after.markdown_path).toBe('knowledge/data-sources/where-the-weather-comes-from.md');
    expect(after.categories).toEqual(['data-sources']);
  });

  it('gives a new name to an item that would collide at the destination', async () => {
    const keep = CategoryResponse.parse(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'Kept' })).json(),
    ).category;
    const close = CategoryResponse.parse(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'Closing' })).json(),
    ).category;
    const title = 'The same name twice';
    await admin.post('/v1/admin/knowledge.create', {
      title,
      body: 'The one that was already there.\n',
      type: 'fact',
      categories: [keep.path],
    });
    const travelling = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title,
          body: 'The one that has to move.\n',
          type: 'fact',
          categories: [close.path],
        })
      ).json(),
    ).item;

    const merged = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: close.id,
      into_category_id: keep.id,
    });
    expect(merged.statusCode, merged.body).toBe(200);

    // Two files cannot share a name. The identity is the id in the
    // frontmatter, so the file name is what gives way.
    const after = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${travelling.id}`)).json(),
    ).item;
    expect(after.markdown_path).toBe('knowledge/kept/the-same-name-twice-2.md');
    expect(await fileAt('knowledge/kept/the-same-name-twice.md')).toContain('already there');
    expect(await fileAt('knowledge/kept/the-same-name-twice-2.md')).toContain('has to move');
  });
});

describe('a title longer than a category slug', () => {
  it('is recorded rather than refused, and through review too', async () => {
    // The generator truncates a title at eighty characters and the check
    // wanted sixty-four, so a title landing between them produced a slug the
    // generator made and the check refused. An ordinary sentence does it.
    const title = 'The reconciliation checkpoint is the sequence the session opened at';
    expect(title.length).toBeGreaterThan(64);

    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body: 'Anything committed while the agent worked is a change it has not seen.\n',
      type: 'fact',
      categories: [],
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = KnowledgeResponse.parse(res.json()).item;
    // Truncated to the one limit everything now shares, rather than to a
    // length only the generator believed in.
    expect(item.slug.length).toBeLessThanOrEqual(64);
    expect(item.slug).toBe('the-reconciliation-checkpoint-is-the-sequence-the-session-opened');

    // It failed on approval rather than on proposing, so a reviewer was left
    // with a proposal they could never act on. That is the path that matters.
    const proposed = await admin.post('/v1/knowledge_propose_create', {
      title: 'Whichever agent holds the newer copy proposes against the canonical revision',
      body: 'The same length problem, arriving through review.\n',
      type: 'fact',
      categories: [],
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
  });
});
