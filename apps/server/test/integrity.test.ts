import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KnowledgeResponse, TERMS_VERSION, type WorkspaceId } from '@knoverge/contracts';
import { IntegrityService, parseLedgerKey } from '@knoverge/core';
import {
  TAXONOMY_PATH,
  contentHash,
  createGitStore,
  frontmatterHash,
  parseItem,
  parseTaxonomy,
} from '@knoverge/git-store';
import { runMigrations } from '@knoverge/db';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
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
let integrity: IntegrityService;
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

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };

/** An item written through the API, so its commit and its rows are the real ones. */
async function anItem(title: string, body: string) {
  const res = await admin.post('/v1/admin/knowledge.create', { title, body, type: 'fact' });
  expect(res.statusCode, res.body).toBe(200);
  return KnowledgeResponse.parse(res.json()).item;
}

const fileOf = (path: string) => join(dataDir, 'repositories', workspaceId, path);

/** git, in a workspace's repository, the way an operator would run it. */
const run = promisify(execFile);
const gitIn = async (repository: string, args: readonly string[]) =>
  (await run('git', ['-C', repository, ...args])).stdout;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-integrity-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('d4'.repeat(32)),
    tokenPepper: 'e5'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
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
  workspaceId = (await services.repositories.workspaces.findBySlug('personal'))!.id;

  // Composed here rather than in the server: nothing in the server calls it, and
  // the command line is where it belongs. What it needs is the repositories and a
  // git store over the same data directory.
  integrity = new IntegrityService({
    workspaces: services.repositories.workspaces,
    items: services.repositories.knowledge,
    revisions: services.repositories.revisions,
    categories: services.repositories.categories,
    operations: services.repositories.operations,
    versions: services.repositories.taxonomyVersions,
    ledger: services.ledger,
    git: createGitStore({ dataDir }),
    parseItem,
    contentHash,
    frontmatterHash,
    parseTaxonomy,
    taxonomyPath: TAXONOMY_PATH,
  });
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('knoverge integrity check', () => {
  it('says the two stores agree, item by item', async () => {
    const item = await anItem('The stores agree', 'Written through the API.\n');
    await admin.post('/v1/admin/knowledge.create', {
      title: 'And so does this one',
      body: 'Also written through the API.\n',
      type: 'decision',
    });

    const report = await integrity.check();
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    const workspace = report.workspaces.find((w) => w.workspaceId === workspaceId);
    // Every item examined, and the chain recomputed rather than assumed.
    expect(workspace?.items).toBeGreaterThanOrEqual(2);
    expect(workspace?.events).toBeGreaterThan(0);
    expect(item.markdown_path).toContain('.md');
  });

  it('finds a file that no longer says what the database recorded', async () => {
    const item = await anItem('Edited behind the application', 'The text as it was.\n');
    const path = fileOf(item.markdown_path);
    const before = await readFile(path, 'utf8');
    try {
      await writeFile(path, before.replace('The text as it was.', 'Something else entirely.'));

      const report = await integrity.check([workspaceId]);
      const finding = report.findings.find(
        (f) => f.objectId === item.id && f.kind === 'content_hash_mismatch',
      );
      // The knowledge is the file, so this is the finding nothing repairs: the
      // hash says what the text was and the text is not that any more.
      expect(finding, JSON.stringify(report.findings)).toBeDefined();
      expect(report.ok).toBe(false);
    } finally {
      await writeFile(path, before);
    }
    expect((await integrity.check([workspaceId])).ok).toBe(true);
  });

  it('finds a frontmatter that disagrees with the revision it came from', async () => {
    const item = await anItem('Frontmatter edited', 'A body nobody touched.\n');
    const path = fileOf(item.markdown_path);
    const before = await readFile(path, 'utf8');
    try {
      // A metadata-only edit: the body still hashes correctly, which is why the
      // check compares fields and not only hashes.
      await writeFile(path, before.replace('type: fact', 'type: decision'));

      const report = await integrity.check([workspaceId]);
      const finding = report.findings.find(
        (f) => f.objectId === item.id && f.kind === 'frontmatter_disagrees',
      );
      expect(finding, JSON.stringify(report.findings)).toBeDefined();
      expect(finding?.detail).toContain('type');
      // Field names and no values: a report is not a place for knowledge.
      expect(finding?.detail).not.toContain('A body nobody touched');
    } finally {
      await writeFile(path, before);
    }
  });

  it('finds a file that is gone', async () => {
    const item = await anItem('Removed from the working tree', 'Still in the history.\n');
    const path = fileOf(item.markdown_path);
    const before = await readFile(path, 'utf8');
    try {
      await rm(path);
      const report = await integrity.check([workspaceId]);
      expect(
        report.findings.find((f) => f.objectId === item.id && f.kind === 'file_missing'),
        JSON.stringify(report.findings),
      ).toBeDefined();
    } finally {
      await writeFile(path, before);
    }
  });

  it('finds items whose repository is not there at all', async () => {
    // The disaster the data volume can produce: PostgreSQL restored and the
    // repositories not. A workspace of its own, because losing one is not
    // something to do to the workspace the other tests read.
    const created = await admin.post('/v1/admin/workspace.create', {
      slug: 'lost',
      name: 'Lost',
    });
    expect(created.statusCode, created.body).toBe(200);
    const lost = (await services.repositories.workspaces.findBySlug('lost'))!.id;
    const item = await admin.request({
      method: 'POST',
      url: '/v1/admin/knowledge.create',
      headers: { 'x-knoverge-workspace': lost },
      payload: { title: 'In the lost workspace', body: 'Written once.\n', type: 'fact' },
    });
    expect(item.statusCode, item.body).toBe(200);
    const written = KnowledgeResponse.parse(item.json()).item;

    await rm(join(dataDir, 'repositories', lost), { recursive: true, force: true });

    const report = await integrity.check([lost]);
    const finding = report.findings.find(
      (f) => f.objectId === written.id && f.kind === 'commit_missing',
    );
    expect(finding, JSON.stringify(report.findings)).toBeDefined();
    // The commit it was looking for, short enough to paste into a git command.
    expect(finding?.detail).toContain('which the repository does not have');
    // And the workspace that still has its repository is unaffected: a report is
    // per workspace, because a restore can lose one and not the others.
    expect((await integrity.check([workspaceId])).ok).toBe(true);
  });

  it('finds a taxonomy file that does not match the tree', async () => {
    // Named, because by now this session belongs to two workspaces and the server
    // refuses to guess which one a write is for.
    const created = await admin.request({
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      headers: { 'x-knoverge-workspace': workspaceId },
      payload: { name: 'Operations' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const path = fileOf(TAXONOMY_PATH);
    const before = await readFile(path, 'utf8');
    try {
      await writeFile(path, before.replace('Operations', 'Operations renamed by hand'));
      const report = await integrity.check([workspaceId]);
      expect(
        report.findings.find((f) => f.kind === 'taxonomy_disagrees'),
        JSON.stringify(report.findings),
      ).toBeDefined();
    } finally {
      await writeFile(path, before);
    }
  });

  it('does not mistake a taxonomy commit for a hand-made one', async () => {
    // A workspace's history interleaves knowledge commits and taxonomy commits, so
    // HEAD is as likely to be one as the other. Asking only the revisions whether
    // they know it would report every category change as somebody editing the
    // repository by hand.
    const created = await admin.request({
      method: 'POST',
      url: '/v1/admin/taxonomy.create',
      headers: { 'x-knoverge-workspace': workspaceId },
      payload: { name: 'Hours and rates' },
    });
    expect(created.statusCode, created.body).toBe(200);

    const report = await integrity.check([workspaceId]);
    expect(
      report.findings.filter((f) => f.kind === 'head_unknown'),
      JSON.stringify(report.findings),
    ).toEqual([]);
  });

  it('finds an unfinished operation, and says which command repairs it', async () => {
    // What recovery resolves. Reported and never repaired here: a checker that
    // wrote would be the fourth way knowledge changes and the least reviewed one.
    await services.database.db.execute(sql`
      INSERT INTO operations (
        id, workspace_id, operation_type, state, actor_id, object_ids, request_id,
        created_at, updated_at
      )
      SELECT 'op_01M3H4Z00000000000000000IN', ${workspaceId}, 'create', 'pending', a.id,
        '{}'::json, 'integrity test', now(), now()
      FROM actors a WHERE a.workspace_id = ${workspaceId} LIMIT 1
    `);
    try {
      const report = await integrity.check([workspaceId]);
      const finding = report.findings.find((f) => f.kind === 'operation_unfinished');
      expect(finding, JSON.stringify(report.findings)).toBeDefined();
      expect(finding?.detail).toContain('knoverge db recover');
    } finally {
      await services.database.db.execute(sql`
        DELETE FROM operations WHERE id = 'op_01M3H4Z00000000000000000IN'
      `);
    }
  });

  it('finds a ledger the chain does not hold together', async () => {
    // Inserted, not edited: the table refuses UPDATE and DELETE, so the way to
    // break a chain is to append something that does not follow from it.
    await services.database.db.execute(sql`
      INSERT INTO events (
        id, workspace_id, sequence, hash_version, event_type, actor_id, request_id,
        object_type, object_id, category_ids, metadata, prev_event_hash, event_hash, created_at
      )
      SELECT 'evt_01M3H4Z00000000000000000BR', ${workspaceId},
        (SELECT max(sequence) + 1 FROM events WHERE workspace_id = ${workspaceId}),
        1, 'workspace.updated', a.id, 'integrity test', 'workspace', ${workspaceId},
        '[]'::jsonb, '{}'::jsonb, 'hmac-sha256:nonsense', 'hmac-sha256:alsononsense', now()
      FROM actors a WHERE a.workspace_id = ${workspaceId} LIMIT 1
    `);
    const report = await integrity.check([workspaceId]);
    const finding = report.findings.find((f) => f.kind === 'ledger_broken');
    expect(finding, JSON.stringify(report.findings)).toBeDefined();
    expect(finding?.detail).toMatch(/hash mismatch|previous hash/u);
  });

  it('notices a commit somebody made by hand', async () => {
    // The gap GIT_REPOSITORY.md names: a commit added on top of HEAD contradicts
    // nothing the database recorded — every revision still points at a commit that
    // exists, every file still hashes to what it should — so the only way to see one
    // is to ask where the branch is.
    // Named, because this session belongs to two workspaces by now.
    const written = await admin.request({
      method: 'POST',
      url: '/v1/admin/knowledge.create',
      headers: { 'x-knoverge-workspace': workspaceId },
      payload: {
        title: 'Before the hand-made commit',
        body: 'Written through the API.\n',
        type: 'fact',
      },
    });
    expect(written.statusCode, written.body).toBe(200);
    const repository = join(dataDir, 'repositories', workspaceId);
    await writeFile(join(repository, 'notes.txt'), 'left here by an operator\n', 'utf8');
    await gitIn(repository, ['add', 'notes.txt']);
    await gitIn(repository, [
      '-c',
      'user.name=Operator',
      '-c',
      'user.email=operator@example.com',
      'commit',
      '-m',
      'by hand',
    ]);

    const report = await integrity.check([workspaceId]);
    const finding = report.findings.find((f) => f.kind === 'head_unknown');
    expect(finding, JSON.stringify(report.findings)).toBeDefined();
    expect(finding?.detail).toContain('no revision and no taxonomy version');
  });
});
