import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  TERMS_VERSION,
  KnowledgeDiffResponse,
  KnowledgeCountsResponse,
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

/**
 * Tags are content, not identifiers (ADR 0019).
 *
 * The rule used to be a slug, so a Russian item could not carry Russian tags
 * in a product whose knowledge is explicitly in any language.
 */
/**
 * Browsing, as opposed to searching.
 *
 * The list is how somebody sees what is there. At seventy items it was a wall
 * of rows with no way to narrow it, which is the state the seeding trial found
 * it in; filtering has to happen on the server, because a page is a page and
 * narrowing only what happens to be loaded answers the wrong question.
 */
describe('narrowing the list', () => {
  beforeAll(async () => {
    expect((await admin.post('/v1/admin/taxonomy.create', { name: 'Browsing' })).statusCode).toBe(
      200,
    );
    expect(
      (
        await admin.post('/v1/admin/taxonomy.create', {
          name: 'Deeper',
          parent_path: 'browsing',
        })
      ).statusCode,
    ).toBe(200);
    const one = await admin.post('/v1/admin/knowledge.create', {
      title: 'A decision in the branch',
      body: 'Body.\n',
      type: 'decision',
      categories: ['browsing'],
    });
    expect(one.statusCode, one.body).toBe(200);
    expect(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'A fact further down',
          body: 'Body.\n',
          type: 'fact',
          categories: ['browsing/deeper'],
        })
      ).statusCode,
    ).toBe(200);
  });

  const list = async (query: string) => {
    const res = await admin.get(`/v1/knowledge.list?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeListResponse.parse(res.json()).items;
  };

  it('covers the branch when given a category, not just its root', async () => {
    const items = await list('category_path=browsing&limit=200');
    const titles = items.map((i) => i.title).sort();
    expect(titles).toEqual(['A decision in the branch', 'A fact further down']);

    // And the leaf on its own is the leaf.
    expect((await list('category_path=browsing%2Fdeeper&limit=200')).map((i) => i.title)).toEqual([
      'A fact further down',
    ]);
  });

  it('narrows by type and by review state', async () => {
    const decisions = await list('category_path=browsing&types=decision&limit=200');
    expect(decisions.map((i) => i.title)).toEqual(['A decision in the branch']);

    // A person wrote both, so both are reviewed; nothing is unreviewed here.
    expect(await list('category_path=browsing&review_states=unreviewed&limit=200')).toEqual([]);
    expect(
      (await list('category_path=browsing&review_states=human_reviewed&limit=200')).length,
    ).toBe(2);
  });

  it('narrows to what nothing backs, which is the pile worth finding', async () => {
    // Everything here was written by a person with no sources given, so the
    // filter has to find all of it and the opposite filter none of it.
    const unsourced = await list('category_path=browsing&evidence_states=none&limit=200');
    expect(unsourced.length).toBe(2);
    expect(await list('category_path=browsing&evidence_states=source_backed&limit=200')).toEqual(
      [],
    );
  });

  it('lists what the workspace asserts, not what it used to', async () => {
    // A list that mixes a superseded item in with the current ones answers a
    // question nobody asked, and the row gives no sign which is which. It
    // also made browsing and searching disagree: search has always asked for
    // active only.
    const before = await list('limit=200');
    const doomed = before[0];
    expect(doomed).toBeTruthy();
    const gone = await admin.post('/v1/admin/knowledge.delete', {
      item_id: doomed?.id,
      base_revision_id: doomed?.current_revision_id,
      base_content_hash: (
        (await admin.get(`/v1/knowledge.get?item_id=${doomed?.id}`)).json() as {
          item: { content_hash: string };
        }
      ).item.content_hash,
    });
    expect(gone.statusCode, gone.body).toBe(200);

    const after = await list('limit=200');
    expect(after.map((i) => i.id)).not.toContain(doomed?.id);
    expect(after.length).toBe(before.length - 1);
    // And still reachable by asking for it, which is what the parameter is for.
    expect((await list('status=deleted&limit=200')).map((i) => i.id)).toContain(doomed?.id);
  });

  it('counts the piles over the workspace, not over a page', async () => {
    // A number describing the fifty rows that happen to be loaded, while
    // claiming to describe the workspace, is worse than no number.
    const res = await admin.get('/v1/knowledge.counts');
    expect(res.statusCode, res.body).toBe(200);
    const { counts } = KnowledgeCountsResponse.parse(res.json());
    // The count and the filter it opens have to agree, or the number is read
    // as a fact and is wrong.
    const everything = await list('limit=200');
    const unsourced = await list('evidence_states=none&limit=200');
    expect(counts.total).toBe(everything.length);
    expect(counts.unsourced).toBe(unsourced.length);
  });

  it('says so when the category does not exist, rather than answering empty', async () => {
    const res = await admin.get('/v1/knowledge.list?category_path=no-such-branch');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

/**
 * Every change is a revision and a Git commit. Until now the history could say
 * who and when, and not why.
 */
describe('why a change was made', () => {
  it('keeps the reason on the revision and in the commit', async () => {
    const created = await admin.post('/v1/admin/knowledge.create', {
      title: 'Backup retention',
      body: 'Thirty days.\n',
      type: 'decision',
      reason: 'Recorded after the incident review.',
    });
    expect(created.statusCode, created.body).toBe(200);
    const item = KnowledgeResponse.parse(created.json()).item;

    const updated = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'Ninety days.\n',
      reason: 'Legal asked for ninety, not thirty.',
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const history = RevisionsResponse.parse(
      (await admin.get(`/v1/knowledge.revisions?item_id=${item.id}`)).json(),
    ).revisions;
    expect(history.map((r) => r.reason)).toEqual([
      'Legal asked for ninety, not thirty.',
      'Recorded after the incident review.',
    ]);

    // In the commit body, where Git has always kept the reason for a change,
    // so `git log` answers without the application.
    const repository = join(dataDir, 'repositories', item.workspace_id);
    const message = await gitIn(repository, ['log', '-1', '--format=%B']);
    expect(message).toContain('update(decision): Backup retention');
    expect(message).toContain('Legal asked for ninety, not thirty.');
    // Above the trailers, not folded into them.
    expect(message.indexOf('Legal asked')).toBeLessThan(message.indexOf('Knoverge-Operation'));
  });

  it('is optional, and absent means null rather than empty', async () => {
    const created = await admin.post('/v1/admin/knowledge.create', {
      title: 'Unexplained item',
      body: 'Body.\n',
      type: 'fact',
    });
    expect(created.statusCode, created.body).toBe(200);
    const item = KnowledgeResponse.parse(created.json()).item;
    const history = RevisionsResponse.parse(
      (await admin.get(`/v1/knowledge.revisions?item_id=${item.id}`)).json(),
    ).revisions;
    expect(history[0]?.reason).toBeNull();
  });

  it('is not in the frontmatter, because that describes the item', async () => {
    // A reason folded into the content hash would make every revision differ
    // from itself, and a reader of the file would meet last week's argument
    // at the top of this week's knowledge.
    const created = await admin.post('/v1/admin/knowledge.create', {
      title: 'Frontmatter stays about the item',
      body: 'Body.\n',
      type: 'fact',
      reason: 'A sentence that must not appear in the file.',
    });
    expect(created.statusCode, created.body).toBe(200);
    const item = KnowledgeResponse.parse(created.json()).item;
    const repository = join(dataDir, 'repositories', item.workspace_id);
    const file = await readFile(join(repository, item.markdown_path), 'utf8');
    expect(file).not.toContain('must not appear');
  });
});

describe('tags in any language', () => {
  it('keeps what was written, and treats two spellings as one tag', async () => {
    const first = await admin.post('/v1/admin/knowledge.create', {
      title: 'Что такое сверка',
      body: 'Сверка — это то, чем агент узнаёт, что пространство уже знает.\n',
      type: 'fact',
      language: 'ru',
      tags: ['Машинное  Обучение', 'сверка'],
    });
    expect(first.statusCode, first.body).toBe(200);
    const item = KnowledgeResponse.parse(first.json()).item;
    // Stored as written, once whitespace is collapsed.
    expect(item.tags).toEqual(['Машинное Обучение', 'сверка']);

    // The file carries them, so the repository is readable without the
    // application — which is the whole reason the frontmatter exists.
    const repository = join(dataDir, 'repositories', item.workspace_id);
    const file = await readFile(join(repository, item.markdown_path), 'utf8');
    expect(file).toContain('Машинное Обучение');

    // A second item spelling one of them differently joins the same tag
    // rather than creating a second one that looks identical.
    const second = await admin.post('/v1/admin/knowledge.create', {
      title: 'Ещё об обучении',
      body: 'Второй элемент с тем же тегом, написанным иначе.\n',
      type: 'fact',
      language: 'ru',
      tags: ['машинное обучение'],
    });
    expect(second.statusCode, second.body).toBe(200);
    const rows = await services.database.pool.query(
      'select name from tags where normalised_name = $1',
      ['машинное обучение'],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses a tag no interface could show or separate', async () => {
    for (const tag of ['git,portability', 'bell\u0007', '   ']) {
      const res = await admin.post('/v1/admin/knowledge.create', {
        title: `Refused ${tag.length}`,
        body: 'Body.\n',
        type: 'fact',
        tags: [tag],
      });
      expect(res.statusCode, `${tag}: ${res.body}`).toBe(400);
    }
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
    // And gone from the list a reader sees, which is what that sentence
    // used to say while the assertion under it checked the opposite.
    const list = KnowledgeListResponse.parse((await admin.get('/v1/knowledge.list')).json());
    expect(list.items.find((i) => i.id === item.id)).toBeUndefined();
    // Still there for somebody who asks for it.
    const removed = KnowledgeListResponse.parse(
      (await admin.get('/v1/knowledge.list?status=deleted')).json(),
    );
    expect(removed.items.find((i) => i.id === item.id)?.status).toBe('deleted');

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

describe('contradictions', () => {
  /** An item, since every one of these needs two or three. */
  async function item(title: string, extra: Record<string, unknown> = {}) {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body: `${title}.\n`,
      type: 'fact',
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  }

  /** The item as it is now, which is the only way to see a verdict move. */
  async function reread(id: string) {
    const res = await admin.get(`/v1/knowledge.get?item_id=${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  }

  function fileOf(workspaceId: string, path: string) {
    return readFile(join(dataDir, 'repositories', workspaceId, path), 'utf8');
  }

  it('marks both items, in one commit, when one reports a contradiction', async () => {
    const held = await item('Deploys happen on Thursdays');
    const reporter = await item('Deploys happen on Tuesdays', {
      relations: [{ type: 'contradicts', target: held.id }],
    });

    // The reporter is disputed as well. Reporting a disagreement is not a way
    // to put somebody else's claim in doubt while keeping your own clean.
    expect(reporter.disputed).toBe(true);
    expect(reporter.disputed_by).toEqual([]);

    // And the other end, which holds no relation of its own, knows who.
    const marked = await reread(held.id);
    expect(marked.disputed).toBe(true);
    expect(marked.disputed_by).toEqual([reporter.id]);
    // A new revision, because its file changed (rule 1).
    expect(marked.revision_number).toBe(held.revision_number + 1);

    // Both files say so, so the repository answers without the application.
    expect(await fileOf(reporter.workspace_id, reporter.markdown_path)).toContain('disputed: true');
    const other = await fileOf(marked.workspace_id, marked.markdown_path);
    expect(other).toContain('disputed: true');
    expect(other).toContain(`disputed_by:\n  - ${reporter.id}`);

    // One commit for both, carrying a change trailer per revision, exactly as
    // a supersession does.
    const repository = join(dataDir, 'repositories', reporter.workspace_id);
    const log = await gitIn(repository, ['log', '-1', '--format=%s%n%b', '--name-only']);
    expect(log).toContain(`Knoverge-Change: ${reporter.id}@${reporter.current_revision_id} create`);
    expect(log).toContain(`Knoverge-Change: ${marked.id}@${marked.current_revision_id} metadata`);
    expect(log).toContain(marked.markdown_path);
  });

  it('clears both when the contradiction is withdrawn', async () => {
    const held = await item('Retention is thirty days');
    let reporter = await item('Retention is ninety days', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    expect((await reread(held.id)).disputed).toBe(true);

    reporter = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: reporter.id,
          base_revision_id: reporter.current_revision_id,
          base_content_hash: reporter.content_hash,
          relations: [],
        })
      ).json(),
    ).item;
    expect(reporter.disputed).toBe(false);

    const cleared = await reread(held.id);
    expect(cleared.disputed).toBe(false);
    expect(cleared.disputed_by).toEqual([]);
    // Absent rather than an empty list: nobody disputes it is one statement.
    expect(await fileOf(cleared.workspace_id, cleared.markdown_path)).not.toContain('disputed_by');
  });

  it('ends the dispute when the contradicted item is superseded', async () => {
    const held = await item('The office is in Brisbane');
    const reporter = await item('The office is in Sydney', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    expect(reporter.disputed).toBe(true);

    // Re-read: being contradicted gave it a revision, and rule 6 wants the one
    // the caller actually holds.
    const current = await reread(held.id);
    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: held.id,
      old_base_revision_id: current.current_revision_id,
      old_base_content_hash: current.content_hash,
      new_item: {
        title: 'The office moved to Sydney',
        body: 'It is in Sydney now.\n',
        type: 'fact',
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    // Nothing was said about the reporter, and it stopped being disputed:
    // there is no longer an active claim on the other side of it.
    const after = await reread(reporter.id);
    expect(after.disputed).toBe(false);
    expect(await fileOf(after.workspace_id, after.markdown_path)).toContain('disputed: false');
  });

  it('hands a dispute from the item it supersedes to the one that replaces it', async () => {
    // The case that needs both changed items weighed at once: the old one
    // leaves the active set while the new one arrives contradicting the same
    // third item, so the third item gets one revision and stays disputed.
    const held = await item('Charges are billed in arrears');
    const first = await item('Charges are billed up front', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    const marked = await reread(held.id);
    expect(marked.disputed_by).toEqual([first.id]);

    const res = await admin.post('/v1/admin/knowledge.supersede', {
      old_item_id: first.id,
      old_base_revision_id: first.current_revision_id,
      old_base_content_hash: first.content_hash,
      new_item: {
        title: 'Charges are billed on the tenth',
        body: 'They go out on the tenth.\n',
        type: 'fact',
        relations: [{ type: 'contradicts', target: held.id }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const replacement = SupersedeResponse.parse(res.json()).item;

    const after = await reread(held.id);
    expect(after.disputed).toBe(true);
    // The new reporter, not the old one, and not both: the superseded item is
    // no longer making a claim.
    expect(after.disputed_by).toEqual([replacement.id]);
    // One revision from the supersession, not one per changed item.
    expect(after.revision_number).toBe(marked.revision_number + 1);
    expect((await reread(first.id)).disputed).toBe(false);
  });

  it('is no dispute when the two claims are given different periods', async () => {
    // The third resolution KNOWLEDGE_LIFECYCLE.md section 6 names: accept both
    // and say when each one held. Two claims that were never true at the same
    // instant do not disagree.
    const held = await item('The rate is five per cent', {
      valid_until: '2026-06-01T00:00:00Z',
    });
    const reporter = await item('The rate is seven per cent', {
      valid_from: '2026-06-01T00:00:00Z',
      relations: [{ type: 'contradicts', target: held.id }],
    });
    expect(reporter.disputed).toBe(false);
    const other = await reread(held.id);
    expect(other.disputed).toBe(false);
    // And the relation is still on record: they do disagree, in the sense that
    // one replaced the other's answer.
    expect(reporter.relations).toEqual([{ type: 'contradicts', target: held.id }]);
    // Nothing changed on the other item, so it got no revision for nothing.
    expect(other.revision_number).toBe(held.revision_number);
  });

  it('lets a window that opens later reopen a dispute', async () => {
    const held = await item('Support closes at five', {
      valid_until: '2026-06-01T00:00:00Z',
    });
    const reporter = await item('Support closes at seven', {
      valid_from: '2026-06-01T00:00:00Z',
      relations: [{ type: 'contradicts', target: held.id }],
    });
    expect(reporter.disputed).toBe(false);

    // Widening the reporter's period back over the other one's makes the
    // disagreement live again, without anybody touching a flag.
    const widened = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: reporter.id,
          base_revision_id: reporter.current_revision_id,
          base_content_hash: reporter.content_hash,
          valid_from: null,
        })
      ).json(),
    ).item;
    expect(widened.disputed).toBe(true);
    expect((await reread(held.id)).disputed_by).toEqual([reporter.id]);
  });

  it('ends the dispute on delete and brings it back on restore', async () => {
    const held = await item('Invoices are monthly');
    const reporter = await item('Invoices are quarterly', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    expect((await reread(held.id)).disputed).toBe(true);

    expect(
      (
        await admin.post('/v1/admin/knowledge.delete', {
          item_id: reporter.id,
          base_revision_id: reporter.current_revision_id,
          base_content_hash: reporter.content_hash,
        })
      ).statusCode,
    ).toBe(200);
    const quiet = await reread(held.id);
    expect(quiet.disputed).toBe(false);
    expect(quiet.disputed_by).toEqual([]);

    expect(
      (await admin.post('/v1/admin/knowledge.restore', { item_id: reporter.id })).statusCode,
    ).toBe(200);
    // The relation was kept through the delete, so the disagreement is back
    // rather than quietly lost.
    const loud = await reread(held.id);
    expect(loud.disputed).toBe(true);
    expect(loud.disputed_by).toEqual([reporter.id]);
    expect((await reread(reporter.id)).disputed).toBe(true);
  });

  it('names every item that disputes one, sorted', async () => {
    const held = await item('We use one queue');
    const first = await item('We use two queues', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    const second = await item('We use three queues', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    const marked = await reread(held.id);
    expect(marked.disputed_by).toEqual([first.id, second.id].sort());
  });

  it('shows the pile of disputed items on its own', async () => {
    const held = await item('Logs are kept for a week');
    await item('Logs are kept for a year', {
      relations: [{ type: 'contradicts', target: held.id }],
    });
    const res = await admin.get('/v1/knowledge.list?disputed=true&limit=100');
    expect(res.statusCode, res.body).toBe(200);
    const ids = KnowledgeListResponse.parse(res.json()).items.map((i) => i.id);
    expect(ids).toContain(held.id);

    // And the count over the pile is the size of the list it opens, which is
    // the whole point of offering a number.
    const counts = KnowledgeCountsResponse.parse(
      (await admin.get('/v1/knowledge.counts')).json(),
    ).counts;
    expect(counts.disputed).toBe(ids.length);
  });
});

describe('summaries', () => {
  async function fact(title: string) {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body: `${title}.\n`,
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  }

  async function reread(id: string) {
    const res = await admin.get(`/v1/knowledge.get?item_id=${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  }

  /** Any change at all, so a dependency moves on. */
  async function touch(item: { id: string; current_revision_id: string; content_hash: string }) {
    const res = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'Something else entirely.\n',
    });
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  }

  it('records what it was made from, in the file and as an index', async () => {
    const one = await fact('Deploys are on Thursdays');
    const two = await fact('Releases are cut on Wednesdays');
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'How releases work',
      body: 'Cut on Wednesday, deployed on Thursday.\n',
      type: 'summary',
      summary_of: [`${one.id}@${one.current_revision_id}`, `${two.id}@${two.current_revision_id}`],
    });
    expect(res.statusCode, res.body).toBe(200);
    const summary = KnowledgeResponse.parse(res.json()).item;
    expect(summary.summary_of).toEqual([
      `${one.id}@${one.current_revision_id}`,
      `${two.id}@${two.current_revision_id}`,
    ]);
    // Nothing has moved, so it is not out of step with anything.
    expect(summary.stale).toBe(false);

    // The file carries it, because the repository is the canonical copy.
    const file = await readFile(
      join(dataDir, 'repositories', summary.workspace_id, summary.markdown_path),
      'utf8',
    );
    expect(file).toContain('summary_of:');
    expect(file).toContain(`- ${one.id}@${one.current_revision_id}`);
  });

  it('is out of date the moment a source moves on, with nothing marking it', async () => {
    // No job, no flag: staleness is computed from the pairs it stored against
    // the items' current revisions (ADR 0024), so it is right immediately.
    const source = await fact('The rate is five per cent');
    const summary = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'What the rates are',
          body: 'Five per cent.\n',
          type: 'summary',
          summary_of: [`${source.id}@${source.current_revision_id}`],
        })
      ).json(),
    ).item;
    expect(summary.stale).toBe(false);

    await touch(source);
    const after = await reread(summary.id);
    expect(after.stale).toBe(true);
    // And the summary itself has not been rewritten: nothing touched it.
    expect(after.current_revision_id).toBe(summary.current_revision_id);
    expect(after.revision_number).toBe(summary.revision_number);
  });

  it('stops being out of date when it is written again from what is current', async () => {
    const source = await fact('Support closes at five');
    let summary = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'What the hours are',
          body: 'Until five.\n',
          type: 'summary',
          summary_of: [`${source.id}@${source.current_revision_id}`],
        })
      ).json(),
    ).item;
    const moved = await touch(source);
    expect((await reread(summary.id)).stale).toBe(true);

    summary = await reread(summary.id);
    const rewritten = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: summary.id,
          base_revision_id: summary.current_revision_id,
          base_content_hash: summary.content_hash,
          body: 'Until seven now.\n',
          summary_of: [`${moved.id}@${moved.current_revision_id}`],
        })
      ).json(),
    ).item;
    // There is no separate step that says "accepted": naming the current
    // revisions *is* the statement that somebody read them.
    expect(rewritten.stale).toBe(false);
  });

  it('answers honestly when it was written from something already out of date', async () => {
    // Legitimate: you summarise what you read, and it may have moved on while
    // you were writing. A write cannot assume its sources were current.
    const source = await fact('Invoices are monthly');
    const first = source.current_revision_id;
    await touch(source);
    const summary = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'What the billing is',
          body: 'Monthly.\n',
          type: 'summary',
          summary_of: [`${source.id}@${first}`],
        })
      ).json(),
    ).item;
    expect(summary.stale).toBe(true);
  });

  it('is out of date when a source is deleted, which is a change like any other', async () => {
    const source = await fact('The office is in Brisbane');
    const summary = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Where the offices are',
          body: 'Brisbane.\n',
          type: 'summary',
          summary_of: [`${source.id}@${source.current_revision_id}`],
        })
      ).json(),
    ).item;
    expect(
      (
        await admin.post('/v1/admin/knowledge.delete', {
          item_id: source.id,
          base_revision_id: source.current_revision_id,
          base_content_hash: source.content_hash,
        })
      ).statusCode,
    ).toBe(200);
    // A summary of something that has left the active index is exactly a
    // summary somebody should look at.
    expect((await reread(summary.id)).stale).toBe(true);
  });

  it('shows the pile of summaries to look at, and counts it', async () => {
    const res = await admin.get('/v1/knowledge.list?stale=true&limit=100');
    expect(res.statusCode, res.body).toBe(200);
    const listed = KnowledgeListResponse.parse(res.json()).items;
    expect(listed.length).toBeGreaterThan(0);
    // Everything in the pile is a summary, and every one says so.
    expect(listed.every((item) => item.type === 'summary' && item.stale)).toBe(true);
    const counts = KnowledgeCountsResponse.parse(
      (await admin.get('/v1/knowledge.counts')).json(),
    ).counts;
    expect(counts.stale).toBe(listed.length);
  });

  it('refuses a revision that belongs to a different item', async () => {
    // The pair has to be a pair. A revision of something else would make the
    // summary go stale against an item it never read.
    const one = await fact('One thing');
    const two = await fact('Another thing');
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'A confused summary',
      body: 'Body.\n',
      type: 'summary',
      summary_of: [`${one.id}@${two.current_revision_id}`],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/is a revision of/);
  });

  it('refuses a summary that summarises itself, and one that names a source twice', async () => {
    const source = await fact('Something to summarise');
    const twice = await admin.post('/v1/admin/knowledge.create', {
      title: 'Named twice',
      body: 'Body.\n',
      type: 'summary',
      summary_of: [
        `${source.id}@${source.current_revision_id}`,
        `${source.id}@${source.current_revision_id}`,
      ],
    });
    expect(twice.statusCode, twice.body).toBe(400);
    expect(twice.json().message).toMatch(/named twice/);

    const summary = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'A summary of something',
          body: 'Body.\n',
          type: 'summary',
          summary_of: [`${source.id}@${source.current_revision_id}`],
        })
      ).json(),
    ).item;
    const itself = await admin.post('/v1/admin/knowledge.update', {
      item_id: summary.id,
      base_revision_id: summary.current_revision_id,
      base_content_hash: summary.content_hash,
      summary_of: [`${summary.id}@${summary.current_revision_id}`],
    });
    expect(itself.statusCode, itself.body).toBe(400);
    expect(itself.json().message).toMatch(/summarise itself/);
  });

  it('refuses anything but a summary claiming to summarise things', async () => {
    const source = await fact('A fact to misuse');
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Not a summary',
      body: 'Body.\n',
      type: 'fact',
      summary_of: [`${source.id}@${source.current_revision_id}`],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/only an item of type summary/);
  });

  it('drops the list when the type changes away from summary', async () => {
    const source = await fact('A source for a demoted summary');
    const summary = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'About to become a fact',
          body: 'Body.\n',
          type: 'summary',
          summary_of: [`${source.id}@${source.current_revision_id}`],
        })
      ).json(),
    ).item;
    const demoted = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.update', {
          item_id: summary.id,
          base_revision_id: summary.current_revision_id,
          base_content_hash: summary.content_hash,
          type: 'fact',
        })
      ).json(),
    ).item;
    // An item that is not a summary claiming to summarise things is a claim the
    // frontmatter schema refuses outright.
    expect(demoted.summary_of).toEqual([]);
    expect(demoted.stale).toBe(false);
  });

  it('refuses a source the workspace does not have', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Points at nothing',
      body: 'Body.\n',
      type: 'summary',
      summary_of: ['kn_01M2ZZZZZZZZZZZZZZZZZZZZZZ@rev_01M2ZZZZZZZZZZZZZZZZZZZZZZ'],
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().message).toMatch(/no revision/);
  });
});

describe('when a claim holds', () => {
  it('keeps the period a write states, and says what it means', async () => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'The backend is MySQL',
      body: 'It was MySQL.\n',
      type: 'fact',
      valid_from: '2026-01-01T00:00:00Z',
      valid_until: '2026-09-18T00:00:00Z',
      observed_at: '2026-09-17T00:00:00Z',
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = KnowledgeResponse.parse(res.json()).item;
    expect(item.valid_from).toBe('2026-01-01T00:00:00.000Z');
    expect(item.valid_until).toBe('2026-09-18T00:00:00.000Z');
    expect(item.observed_at).toBe('2026-09-17T00:00:00.000Z');
    // And the file carries them, because the repository is the canonical copy.
    const file = await readFile(
      join(dataDir, 'repositories', item.workspace_id, item.markdown_path),
      'utf8',
    );
    expect(file).toMatch(/valid_from: .*2026-01-01T00:00:00/u);
    expect(file).toMatch(/valid_until: .*2026-09-18T00:00:00/u);
  });

  it('refuses a period that ends before it starts', async () => {
    // It reads as a claim nothing was ever true in, and since ADR 0022 it would
    // quietly close a contradiction rather than declare one.
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Backwards in time',
      body: 'Body.\n',
      type: 'fact',
      valid_from: '2026-09-18T00:00:00Z',
      valid_until: '2026-01-01T00:00:00Z',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(res.json().message).toMatch(/valid_until is earlier than valid_from/);
  });

  it('refuses one an update would create, against the dates already there', async () => {
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Starts in June',
          body: 'Body.\n',
          type: 'fact',
          valid_from: '2026-06-01T00:00:00Z',
        })
      ).json(),
    ).item;
    // Only the end is sent, so the start is the one already on the item: the
    // check is against what the write leaves behind, not against what it says.
    const res = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      valid_until: '2026-01-01T00:00:00Z',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('allows a claim replaced the instant it was made', async () => {
    // A zero-length period is not a typo: it is what an item superseded at the
    // moment it was written actually held for.
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Held for no time at all',
          body: 'Body.\n',
          type: 'fact',
          valid_from: '2026-06-01T00:00:00Z',
          valid_until: '2026-06-01T00:00:00Z',
        })
      ).json(),
    ).item;
    expect(item.valid_from).toBe(item.valid_until);
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

/**
 * Two writers reaching the same item at the same moment.
 *
 * Rule 6 is about what the caller read, and what the caller read is only worth
 * checking against state nobody else can be changing. The check used to run
 * before the workspace lock was taken, so both writers passed it, both were let
 * through, and the second rendered its file from a revision that no longer
 * existed: a commit landed in Git, the insert failed on the revision number
 * already taken, and the workspace was left holding an unfinished operation
 * that refused every write until an operator resolved it.
 *
 * Each of these asserts the same two things: exactly one writer wins, and the
 * workspace is still writable afterwards.
 */
describe('two writers at once', () => {
  const anItem = async (title: string) => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body: 'What both writers read.',
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
    return KnowledgeResponse.parse(res.json()).item;
  };

  /** The workspace accepts writes, which an unfinished operation would refuse. */
  const stillWritable = async (title: string) => {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body: 'Written after the race.',
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  it('lets one update through and answers the other with a conflict', async () => {
    const item = await anItem('Two updates');
    const base = {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
    };
    const [a, b] = await Promise.all([
      admin.post('/v1/admin/knowledge.update', { ...base, body: 'Edit A.' }),
      admin.post('/v1/admin/knowledge.update', { ...base, body: 'Edit B.' }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.body}\n${b.body}`).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().code).toBe('REVISION_CONFLICT');
    // The loser is told what to re-read, which is what makes a retry possible.
    expect(loser.json().object_ids.current_revision_id).not.toBe(item.current_revision_id);

    // The winner's text is what is there, not the loser's written over it.
    const after = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${item.id}`)).json(),
    ).item;
    expect(after.revision_number).toBe(2);
    await stillWritable('After two updates');
  });

  it('deletes an item once, however many callers ask', async () => {
    const item = await anItem('Two deletes');
    const base = {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
    };
    const [a, b] = await Promise.all([
      admin.post('/v1/admin/knowledge.delete', base),
      admin.post('/v1/admin/knowledge.delete', base),
    ]);

    // The loser reads the item after the first delete took it out of the
    // index, so it is told the item is gone — the same answer a second delete
    // has always given — rather than committing a second removal over it.
    expect([a.statusCode, b.statusCode].sort(), `${a.body}\n${b.body}`).toEqual([200, 404]);
    await stillWritable('After two deletes');
  });

  it('lets one supersession through and answers the other with a conflict', async () => {
    const item = await anItem('Two supersessions');
    const base = {
      old_item_id: item.id,
      old_base_revision_id: item.current_revision_id,
      old_base_content_hash: item.content_hash,
    };
    const [a, b] = await Promise.all([
      admin.post('/v1/admin/knowledge.supersede', {
        ...base,
        new_item: { title: 'Replacement A', body: 'Took over.', type: 'fact' },
      }),
      admin.post('/v1/admin/knowledge.supersede', {
        ...base,
        new_item: { title: 'Replacement B', body: 'Took over.', type: 'fact' },
      }),
    ]);

    expect([a.statusCode, b.statusCode].sort(), `${a.body}\n${b.body}`).toEqual([200, 409]);
    // One replacement exists, not two: the loser wrote nothing at all.
    // The whole workspace, not the first page: this suite adds items, and a
    // page-sized window turns an assertion about the workspace into one about
    // how much was written before it.
    const list = KnowledgeListResponse.parse(
      (await admin.get('/v1/knowledge.list?limit=200')).json(),
    );
    const replacements = list.items.filter((i) => i.title.startsWith('Replacement '));
    expect(replacements).toHaveLength(1);
    await stillWritable('After two supersessions');
  });

  it('restores an item once, however many callers ask', async () => {
    const item = await anItem('Two restores');
    const deleted = await admin.post('/v1/admin/knowledge.delete', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    const [a, b] = await Promise.all([
      admin.post('/v1/admin/knowledge.restore', { item_id: item.id }),
      admin.post('/v1/admin/knowledge.restore', { item_id: item.id }),
    ]);

    // The second reads the item after the first put it back, so it is told the
    // item is not deleted rather than writing a second restore over the first.
    expect([a.statusCode, b.statusCode].sort(), `${a.body}\n${b.body}`).toEqual([200, 400]);
    await stillWritable('After two restores');
  });
});
