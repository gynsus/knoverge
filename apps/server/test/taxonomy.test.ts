import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  TERMS_VERSION,
  ActorsResponse,
  CategoryResponse,
  TaxonomyListResponse,
} from '@knoverge/contracts';
import { MAX_CATEGORY_DEPTH, parseLedgerKey, slugify } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import { parseTaxonomy } from '@knoverge/git-store';
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

async function create(body: Record<string, unknown>) {
  const res = await admin.post('/v1/admin/taxonomy.create', body);
  expect(res.statusCode, res.body).toBe(200);
  return CategoryResponse.parse(res.json());
}

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

describe('creating categories', () => {
  it('derives the slug and path and bumps the taxonomy version', async () => {
    const before = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    const projects = await create({ name: 'Projects' });
    expect(projects.category.slug).toBe('projects');
    expect(projects.category.path).toBe('projects');
    expect(projects.taxonomy_version).toBe(before.taxonomy_version + 1);

    const child = await create({ name: 'Pixel Brisbane', parent_path: 'projects' });
    expect(child.category.path).toBe('projects/pixel-brisbane');
    expect(child.category.parent_id).toBe(projects.category.id);

    const events = await services.repositories.events.listAfter(
      projects.category.workspace_id,
      0,
      200,
    );
    const created = events.filter((e) => e.eventType === 'category.created');
    expect(created.at(-1)?.metadata).toMatchObject({ path: 'projects/pixel-brisbane' });
    expect(created.at(-1)?.categoryIds).toEqual([child.category.id]);
    expect((await services.ledger.verify(projects.category.workspace_id)).ok).toBe(true);
  });

  it('refuses a duplicate path and an unknown parent', async () => {
    const dup = await admin.post('/v1/admin/taxonomy.create', { name: 'Projects' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('CATEGORY_CONFLICT');
    const orphan = await admin.post('/v1/admin/taxonomy.create', {
      name: 'X',
      parent_path: 'nope',
    });
    expect(orphan.statusCode).toBe(404);
  });

  it('accepts aliases and refuses one that is already in use', async () => {
    const career = await create({ name: 'Career', aliases: ['Job search', '  job   SEARCH  '] });
    // Aliases are matched case-insensitively with collapsed spaces, so the duplicate is dropped.
    expect(career.category.aliases).toEqual(['Job search']);
    const clash = await admin.post('/v1/admin/taxonomy.create', {
      name: 'Employment',
      aliases: ['JOB SEARCH'],
    });
    expect(clash.statusCode).toBe(409);
  });

  it('accepts a name in another script', async () => {
    const cyrillic = await create({ name: 'Архитектура' });
    expect(cyrillic.category.path).toBe('arhitektura');
    expect(cyrillic.category.name).toBe('Архитектура');
    // A script with no transliteration still yields a usable identifier.
    const other = await create({ name: '日本語' });
    expect(other.category.slug).toMatch(/^category-[0-9a-z]{8}$/);
    expect(other.category.name).toBe('日本語');
  });

  it('validates names and slugs', async () => {
    expect((await admin.post('/v1/admin/taxonomy.create', { name: '' })).statusCode).toBe(400);
    expect(
      (await admin.post('/v1/admin/taxonomy.create', { name: 'X', slug: 'Not A Slug' })).statusCode,
    ).toBe(400);
  });

  it('refuses to nest deeper than the limit', async () => {
    let parent: string | undefined;
    for (let depth = 1; depth <= MAX_CATEGORY_DEPTH; depth += 1) {
      const res = await admin.post('/v1/admin/taxonomy.create', {
        name: `Level ${depth}`,
        ...(parent ? { parent_path: parent } : {}),
      });
      if (depth <= MAX_CATEGORY_DEPTH) {
        expect(res.statusCode, `depth ${depth}: ${res.body}`).toBe(200);
        parent = CategoryResponse.parse(res.json()).category.path;
      }
    }
    const tooDeep = await admin.post('/v1/admin/taxonomy.create', {
      name: 'Too deep',
      parent_path: parent!,
    });
    expect(tooDeep.statusCode).toBe(400);
  });
});

describe('updating and moving', () => {
  it('renames the slug and rewrites descendant paths', async () => {
    const root = await create({ name: 'Rename root' });
    const child = await create({ name: 'Child', parent_path: root.category.path });
    const grandchild = await create({ name: 'Grandchild', parent_path: child.category.path });

    const res = await admin.post('/v1/admin/taxonomy.update', {
      category_id: root.category.id,
      slug: 'renamed-root',
      name: 'Renamed root',
    });
    expect(res.statusCode, res.body).toBe(200);
    const updated = CategoryResponse.parse(res.json());
    expect(updated.category.path).toBe('renamed-root');

    const list = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    const paths = Object.fromEntries(list.categories.map((c) => [c.id, c.path]));
    expect(paths[child.category.id]).toBe('renamed-root/child');
    expect(paths[grandchild.category.id]).toBe('renamed-root/child/grandchild');

    // Renaming a nested category keeps the parent prefix.
    const nested = await admin.post('/v1/admin/taxonomy.update', {
      category_id: child.category.id,
      slug: 'renamed-child',
    });
    expect(nested.statusCode, nested.body).toBe(200);
    expect(CategoryResponse.parse(nested.json()).category.path).toBe('renamed-root/renamed-child');
    const after = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    expect(after.categories.find((c) => c.id === grandchild.category.id)?.path).toBe(
      'renamed-root/renamed-child/grandchild',
    );
  });

  it('moves a subtree under a new parent', async () => {
    const source = await create({ name: 'Source' });
    const moving = await create({ name: 'Moving', parent_path: source.category.path });
    await create({ name: 'Leaf', parent_path: moving.category.path });
    const target = await create({ name: 'Target' });

    const res = await admin.post('/v1/admin/taxonomy.move', {
      category_id: moving.category.id,
      new_parent_id: target.category.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    const list = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    const paths = list.categories.map((c) => c.path);
    expect(paths).toContain('target/moving');
    expect(paths).toContain('target/moving/leaf');
    expect(paths).not.toContain('source/moving');
  });

  it('reports a path collision as a conflict, not an internal error', async () => {
    // The path is written by the subtree rewrite, so the collision surfaces there.
    const first = await create({ name: 'Collision one' });
    await create({ name: 'Collision two' });
    const res = await admin.post('/v1/admin/taxonomy.update', {
      category_id: first.category.id,
      slug: 'collision-two',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CATEGORY_CONFLICT');
  });

  it('leaves a prefix-sharing sibling untouched when renaming', async () => {
    const root = await create({ name: 'Prefix' });
    await create({ name: 'Prefix archive' });
    await create({ name: 'Child', parent_path: root.category.path });
    const res = await admin.post('/v1/admin/taxonomy.update', {
      category_id: root.category.id,
      slug: 'prefix-renamed',
    });
    expect(res.statusCode, res.body).toBe(200);
    const list = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    const paths = list.categories.map((c) => c.path);
    expect(paths).toContain('prefix-renamed');
    expect(paths).toContain('prefix-renamed/child');
    expect(paths).toContain('prefix-archive');
  });

  it('records the categories the move actually touched', async () => {
    const source = await create({ name: 'Event source' });
    const moving = await create({ name: 'Event moving', parent_path: source.category.path });
    const leaf = await create({ name: 'Event leaf', parent_path: moving.category.path });
    const target = await create({ name: 'Event target' });
    const res = await admin.post('/v1/admin/taxonomy.move', {
      category_id: moving.category.id,
      new_parent_id: target.category.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    const events = await services.repositories.events.listAfter(
      source.category.workspace_id,
      0,
      1000,
    );
    const moved = events.filter((e) => e.eventType === 'category.moved').at(-1)!;
    expect(moved.categoryIds).toEqual(
      expect.arrayContaining([moving.category.id, leaf.category.id]),
    );
    expect(moved.categoryIds).toHaveLength(2);
    expect(moved.metadata).toMatchObject({ moved_categories: 2 });
  });

  it('refuses a move into its own subtree', async () => {
    const root = await create({ name: 'Cycle root' });
    const child = await create({ name: 'Cycle child', parent_path: root.category.path });
    const res = await admin.post('/v1/admin/taxonomy.move', {
      category_id: root.category.id,
      new_parent_id: child.category.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/subtree/);
  });

  it('promotes a category to a root', async () => {
    const root = await create({ name: 'Promote root' });
    const child = await create({ name: 'Promote child', parent_path: root.category.path });
    const res = await admin.post('/v1/admin/taxonomy.move', {
      category_id: child.category.id,
      new_parent_id: null,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(CategoryResponse.parse(res.json()).category.path).toBe('promote-child');
  });
});

describe('archiving and listing', () => {
  it('archives a subtree and hides it by default', async () => {
    const root = await create({ name: 'Archive root' });
    await create({ name: 'Archive child', parent_path: root.category.path });
    const res = await admin.post('/v1/admin/taxonomy.archive', { category_id: root.category.id });
    expect(res.statusCode, res.body).toBe(200);

    const visible = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    expect(visible.categories.map((c) => c.path)).not.toContain('archive-root');
    const all = TaxonomyListResponse.parse(
      (await admin.get('/v1/taxonomy.list?include_archived=true')).json(),
    );
    const archived = all.categories.filter((c) => c.path.startsWith('archive-root'));
    expect(archived).toHaveLength(2);
    expect(archived.every((c) => c.status === 'archived')).toBe(true);
  });

  it('restores an archived subtree', async () => {
    const root = await create({ name: 'Restore root' });
    await create({ name: 'Restore child', parent_path: root.category.path });
    expect(
      (await admin.post('/v1/admin/taxonomy.archive', { category_id: root.category.id }))
        .statusCode,
    ).toBe(200);

    const res = await admin.post('/v1/admin/taxonomy.restore', { category_id: root.category.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(CategoryResponse.parse(res.json()).category.status).toBe('active');

    const visible = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    const back = visible.categories.filter((c) => c.path.startsWith('restore-root'));
    expect(back).toHaveLength(2);
    expect(back.every((c) => c.status === 'active')).toBe(true);
  });

  it('refuses to restore a category that is already active', async () => {
    const root = await create({ name: 'Restore active' });
    const res = await admin.post('/v1/admin/taxonomy.restore', { category_id: root.category.id });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a taxonomy file larger than the limit', async () => {
    // The whole file is rewritten and committed by every change, so its size is
    // paid again on each one. Guidance is the cheapest way to make it large.
    const guidance = Array.from({ length: 50 }, () => 'x'.repeat(500));
    let refused: { statusCode: number; body: string } | null = null;
    for (let n = 0; n < 40 && refused === null; n += 1) {
      const res = await admin.post('/v1/admin/taxonomy.create', {
        name: `Bulky ${n}`,
        inclusion_guidance: guidance,
        exclusion_guidance: guidance,
      });
      if (res.statusCode !== 200) refused = { statusCode: res.statusCode, body: res.body };
    }
    expect(refused?.statusCode, refused?.body ?? 'nothing was refused').toBe(400);
    expect(JSON.parse(refused!.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('filters by root path and depth, and can omit guidance', async () => {
    const root = await create({ name: 'Filter root', inclusion_guidance: ['keep this'] });
    const child = await create({ name: 'Filter child', parent_path: root.category.path });
    await create({ name: 'Filter leaf', parent_path: child.category.path });

    const one = TaxonomyListResponse.parse(
      (await admin.get(`/v1/taxonomy.list?root_path=${root.category.path}&depth=1`)).json(),
    );
    expect(one.categories.map((c) => c.path)).toEqual(['filter-root', 'filter-root/filter-child']);
    expect(one.categories[0]?.inclusion_guidance).toEqual(['keep this']);

    const compact = TaxonomyListResponse.parse(
      (
        await admin.get(`/v1/taxonomy.list?root_path=${root.category.path}&include_guidance=false`)
      ).json(),
    );
    expect(compact.categories[0]?.inclusion_guidance).toEqual([]);
  });

  it('lets a member read but not change the taxonomy', async () => {
    const viewer = await services.users.prepare({
      email: 'reader@example.com',
      password: 'yet another long passphrase',
      displayName: 'Reader',
    });
    const workspace = (await services.repositories.workspaces.list())[0]!;
    const { addMember } = await import('@knoverge/core');
    await services.uow.run(async (tx) => {
      await services.users.insert(tx, viewer);
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
        'test',
        new Date(),
      );
    });
    const browser = new Browser();
    browser.csrf = ((await browser.get('/v1/auth/csrf')).json() as { token: string }).token;
    expect(
      (
        await browser.post('/v1/auth/login', {
          email: 'reader@example.com',
          password: 'yet another long passphrase',
        })
      ).statusCode,
    ).toBe(200);
    expect((await browser.get('/v1/taxonomy.list')).statusCode).toBe(200);
    expect((await browser.post('/v1/admin/taxonomy.create', { name: 'Nope' })).statusCode).toBe(
      403,
    );
  });

  it('refuses taxonomy reads without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/taxonomy.list' })).statusCode).toBe(401);
  });
});

describe('concurrency', () => {
  it('gives concurrent taxonomy changes distinct, gapless versions', async () => {
    const workspace = (await services.repositories.workspaces.list())[0]!;
    const actorRecord = await services.repositories.actors.findSystemActor(workspace.id);
    const actor = {
      workspaceId: workspace.id,
      actorId: actorRecord!.id,
      actorType: 'system' as const,
      requestId: 'concurrency-test',
    };
    const before = await services.taxonomy.currentVersion(workspace.id);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        services.taxonomy.create(actor, { name: `Concurrent ${i}` }),
      ),
    );
    const versions = results.map((r) => r.taxonomyVersion).sort((a, b) => a - b);
    expect(new Set(versions).size).toBe(8);
    expect(versions).toEqual(Array.from({ length: 8 }, (_, i) => before + i + 1));
    expect(await services.taxonomy.currentVersion(workspace.id)).toBe(before + 8);
    expect((await services.ledger.verify(workspace.id)).ok).toBe(true);
  });
});

describe('slugify', () => {
  it('produces safe slugs', () => {
    expect(slugify('Pixel Brisbane')).toBe('pixel-brisbane');
    expect(slugify('  Über Café!  ')).toBe('uber-cafe');
    expect(slugify('A'.repeat(100))).toHaveLength(64);
  });
});

describe('merging', () => {
  /** The tree as the workspace holds it now, by path. */
  async function tree() {
    const res = await admin.get('/v1/taxonomy.list?include_archived=true');
    expect(res.statusCode, res.body).toBe(200);
    const listed = TaxonomyListResponse.parse(res.json());
    return new Map(listed.categories.map((c) => [c.path, c]));
  }

  it('moves children and aliases, keeps the old path reachable and records it', async () => {
    const survivor = await create({ name: 'Data Sources', aliases: ['datasets'] });
    const closing = await create({ name: 'Data Providers', aliases: ['providers'] });
    await create({ name: 'External', parent_path: closing.category.path });

    const res = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: closing.category.id,
      into_category_id: survivor.category.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    const merged = CategoryResponse.parse(res.json());
    expect(merged.category.id).toBe(survivor.category.id);

    const after = await tree();
    // The closed category stays, saying where everything went. Deleting it
    // would take the record of the merge with it.
    const closed = after.get('data-providers')!;
    expect(closed.status).toBe('merged');
    expect(closed.merged_into_category_id).toBe(survivor.category.id);
    expect(closed.aliases).toEqual([]);

    // Its child moved rather than being orphaned or deleted.
    expect(after.has('data-providers/external')).toBe(false);
    expect(after.get('data-sources/external')?.parent_id).toBe(survivor.category.id);

    // Anything that referred to the closed category still resolves: its own
    // aliases, its name, and the path it used to live at.
    expect(after.get('data-sources')!.aliases).toEqual(
      expect.arrayContaining(['datasets', 'providers', 'data-providers', 'Data Providers']),
    );

    const events = await services.repositories.events.listAfter(
      merged.category.workspace_id,
      0,
      500,
    );
    expect(events.at(-1)).toMatchObject({
      eventType: 'category.merged',
      metadata: { path: 'data-providers', into_path: 'data-sources', moved_categories: 1 },
    });
    expect((await services.ledger.verify(merged.category.workspace_id)).ok).toBe(true);
  });

  it('commits a taxonomy file that agrees with the database', async () => {
    // The file is rendered from a projection of the change rather than from
    // the database, so the two are separate implementations of one rule. A
    // merge is the newest of them and has the most to get wrong.
    const survivor = await create({ name: 'Runbooks' });
    const closing = await create({ name: 'Run Books' });
    await create({ name: 'Deploys', parent_path: closing.category.path });
    const res = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: closing.category.id,
      into_category_id: survivor.category.id,
    });
    expect(res.statusCode, res.body).toBe(200);

    const listed = TaxonomyListResponse.parse(
      (await admin.get('/v1/taxonomy.list?include_archived=true')).json(),
    );
    // Read off disk and parsed with the repository's own reader: the point is
    // what somebody without the application would find, and comparing against
    // the rendered text would pin the test to the file's layout rather than to
    // its content.
    const file = await readFile(
      join(dataDir, 'repositories', listed.categories[0]!.workspace_id, 'taxonomy.yaml'),
      'utf8',
    );
    const committed = parseTaxonomy(file);
    expect(committed.version).toBe(listed.taxonomy_version);
    expect(committed.categories.map((c) => c.path).sort()).toEqual(
      listed.categories.map((c) => c.path).sort(),
    );
    // The moved child is at its new place, and the closed category says so.
    expect(committed.categories.find((c) => c.path === 'runbooks/deploys')).toBeDefined();
    expect(committed.categories.find((c) => c.path === 'run-books')?.status).toBe('merged');
  });

  it('takes the closed category out of the live tree', async () => {
    const survivor = await create({ name: 'Incidents' });
    const closing = await create({ name: 'Incident Reports' });
    const merged = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: closing.category.id,
      into_category_id: survivor.category.id,
    });
    expect(merged.statusCode, merged.body).toBe(200);

    // A merged category holds nothing and refuses to be written to, so
    // listing it beside the live ones would invite an agent to file knowledge
    // into a name that answers CATEGORY_CONFLICT.
    const live = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    expect(live.categories.map((c) => c.path)).not.toContain('incident-reports');
    expect(live.categories.every((c) => c.status === 'active')).toBe(true);

    // It is still there for anybody asking for the closed ones, which is how
    // the merge stays readable.
    const all = TaxonomyListResponse.parse(
      (await admin.get('/v1/taxonomy.list?include_archived=true')).json(),
    );
    expect(all.categories.map((c) => c.path)).toContain('incident-reports');
  });

  it('refuses a merge that would swallow the survivor or collide', async () => {
    const parent = await create({ name: 'Playbooks' });
    const child = await create({ name: 'Onboarding', parent_path: parent.category.path });

    const intoOwnSubtree = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: parent.category.id,
      into_category_id: child.category.id,
    });
    expect(intoOwnSubtree.statusCode, intoOwnSubtree.body).toBe(400);

    const intoItself = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: parent.category.id,
      into_category_id: parent.category.id,
    });
    expect(intoItself.statusCode, intoItself.body).toBe(400);

    // Two children of the same slug cannot share a parent.
    const other = await create({ name: 'Handbooks' });
    await create({ name: 'Onboarding', parent_path: other.category.path });
    const clash = await admin.post('/v1/admin/taxonomy.merge', {
      category_id: parent.category.id,
      into_category_id: other.category.id,
    });
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json().code).toBe('CATEGORY_CONFLICT');
  });
});

describe('actor names', () => {
  it('turns the actor id on a category into something readable', async () => {
    const listed = TaxonomyListResponse.parse((await admin.get('/v1/taxonomy.list')).json());
    const category = listed.categories[0]!;
    expect(category.created_by_actor_id).toMatch(/^act_/);

    const res = await admin.get('/v1/actors.list');
    expect(res.statusCode, res.body).toBe(200);
    const actors = ActorsResponse.parse(res.json()).actors;
    const creator = actors.find((a) => a.id === category.created_by_actor_id);
    expect(creator).toMatchObject({ type: 'human', display_name: 'Owner', disabled: false });
    // The workspace's own actor is there too, which is what the ledger
    // attributes a workspace's first events to.
    expect(actors.some((a) => a.type === 'system')).toBe(true);
  });
});
