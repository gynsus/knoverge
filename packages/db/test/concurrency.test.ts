import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, CategoryId, UserId, WorkspaceId } from '@knoverge/contracts';
import { sql } from 'drizzle-orm';

import type { ActorContext } from '@knoverge/core';
import {
  sortedAliases,
  AuthorizationService,
  BootstrapService,
  CrossStoreWriter,
  EventLedger,
  MAX_FAILED_LOGINS,
  MemberService,
  TaxonomyService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
} from '@knoverge/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TAXONOMY_PATH,
  createGitStore,
  parseTaxonomy,
  renderTaxonomy,
  type FlatCategory,
} from '@knoverge/git-store';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

/**
 * These reproduce races that a single-process unit test cannot show: two
 * requests reading the same state and each writing on the strength of it.
 * Every one of them produced corrupt data before the checks moved inside the
 * transaction that holds the lock.
 */
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('d'.repeat(64));
const PASSWORD = 'correct horse battery staple';

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let repositories: ReturnType<typeof createRepositories>;
let taxonomy: TaxonomyService;
let members: MemberService;
let users: UserService;
let workspaceId: WorkspaceId;
let repoRoot: string;
let uow: ReturnType<typeof createUnitOfWork>;
let actor: ActorContext;

const context = (requestId: string): ActorContext => ({ ...actor, requestId });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 16 });
  // Stopping the container terminates whatever connections are still idle, and
  // the pool reports that as an error nobody is awaiting. It is teardown, not a
  // failure, so it is absorbed here rather than failing the run.
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);
  repositories = createRepositories(handle.db);
  uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({ key, events: repositories.events });
  users = new UserService({
    uow,
    users: repositories.users,
    passwords: {
      // Deliberately slow, so the read-modify-write window is wide enough to
      // see. The real hash is argon2, which is slower still.
      hash: async (p) => `hashed:${p}`,
      verify: async (p, h) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return h === `hashed:${p}`;
      },
      dummyHash: async () => 'hashed:__dummy__',
    },
  });
  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  const authorization = new AuthorizationService({
    uow,
    grants: repositories.grants,
    rules: repositories.policyRules,
    categories: repositories.categories,
    ledger,
  });
  const bootstrap = new BootstrapService({
    uow,
    users,
    workspaces,
    memberships: repositories.memberships,
    actors: repositories.actors,
    ledger,
  });
  const created = await bootstrap.run({
    user: { email: 'owner@example.com', password: PASSWORD, displayName: 'Owner', locale: 'en' },
    workspace: { slug: 'personal', name: 'Personal' },
    requestId: 'bootstrap',
  });
  workspaceId = created.workspace.id;
  actor = {
    workspaceId,
    actorId: (await repositories.actors.findSystemActor(workspaceId))!.id as ActorId,
    actorType: 'system',
    requestId: 'setup',
  };
  // A real repository on disk: these tests are about what two writers do to
  // each other, and a stub would hide a lock that is not actually held.
  repoRoot = await mkdtemp(join(tmpdir(), 'knoverge-taxonomy-'));
  const git = createGitStore({ dataDir: repoRoot });
  taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
    crossStore: new CrossStoreWriter({
      uow,
      operations: repositories.operations,
      commitExists: (workspaceId, operationId) =>
        git.hasCommitForOperation(workspaceId, operationId),
    }),
    git,
    renderTaxonomy,
    taxonomyPath: TAXONOMY_PATH,
    workspaces: {
      findById: async (id) => {
        const workspace = await repositories.workspaces.findById(id);
        return workspace ? { id: workspace.id, name: workspace.name } : null;
      },
    },
    actors: repositories.actors,
  });
  members = new MemberService({
    uow,
    memberships: repositories.memberships,
    actors: repositories.actors,
    workspaces: repositories.workspaces,
    users,
    authorization,
    ledger,
  });
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

/** Every category's path must be its parent's path plus its own slug. */
async function assertTreeIsConsistent() {
  const all = await repositories.categories.list(workspaceId, { includeArchived: true });
  const byId = new Map(all.map((c) => [c.id as string, c]));
  for (const category of all) {
    const parent = category.parentId ? byId.get(category.parentId) : null;
    expect(category.parentId === null || parent, `parent of ${category.path} exists`).toBeTruthy();
    const expected = parent ? `${parent.path}/${category.slug}` : category.slug;
    expect(category.path, `path of ${category.id} agrees with its parent and slug`).toBe(expected);
  }
  // No cycles: walking up from every category must reach a root.
  for (const category of all) {
    const seen = new Set<string>();
    let current: typeof category | null | undefined = category;
    while (current) {
      expect(seen.has(current.id), `no cycle above ${category.path}`).toBe(false);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
  }
}

describe('concurrent taxonomy mutations', () => {
  it('keeps parent and path in step when a parent is renamed during a move', async () => {
    for (let round = 0; round < 8; round += 1) {
      const p = await taxonomy.create(context(`p-${round}`), { name: `Parent ${round}` });
      const c = await taxonomy.create(context(`c-${round}`), {
        name: `Child ${round}`,
        parentPath: p.category.path,
      });
      const d = await taxonomy.create(context(`d-${round}`), { name: `Destination ${round}` });

      await Promise.allSettled([
        taxonomy.update(context(`u-${round}`), {
          categoryId: p.category.id,
          slug: `renamed-${round}`,
        }),
        taxonomy.move(context(`m-${round}`), c.category.id, d.category.id),
      ]);
    }
    await assertTreeIsConsistent();
  });

  it('keeps parent and path in step when a parent and a child are renamed together', async () => {
    for (let round = 0; round < 8; round += 1) {
      const p = await taxonomy.create(context(`pp-${round}`), { name: `Outer ${round}` });
      const c = await taxonomy.create(context(`cc-${round}`), {
        name: `Inner ${round}`,
        parentPath: p.category.path,
      });
      await Promise.allSettled([
        taxonomy.update(context(`up-${round}`), {
          categoryId: p.category.id,
          slug: `outer-${round}-x`,
        }),
        taxonomy.update(context(`uc-${round}`), {
          categoryId: c.category.id,
          slug: `inner-${round}-x`,
        }),
      ]);
      // The child is still reachable by the path it reports.
      const child = await repositories.categories.findById(
        workspaceId,
        c.category.id as CategoryId,
      );
      expect(await repositories.categories.findByPath(workspaceId, child!.path)).toMatchObject({
        id: child!.id,
      });
    }
    await assertTreeIsConsistent();
  });

  it('refuses to make two categories each other’s parent', async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await taxonomy.create(context(`a-${round}`), { name: `Alpha ${round}` });
      const b = await taxonomy.create(context(`b-${round}`), { name: `Beta ${round}` });
      const results = await Promise.allSettled([
        taxonomy.move(context(`ma-${round}`), a.category.id, b.category.id),
        taxonomy.move(context(`mb-${round}`), b.category.id, a.category.id),
      ]);
      // At most one can succeed: the second sees the first and is refused.
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    }
    await assertTreeIsConsistent();
  });

  it('never leaves an active category under an archived parent', async () => {
    for (let round = 0; round < 6; round += 1) {
      const p = await taxonomy.create(context(`ap-${round}`), { name: `Archivable ${round}` });
      await Promise.allSettled([
        taxonomy.archive(context(`ar-${round}`), p.category.id),
        taxonomy.create(context(`ac-${round}`), {
          name: `Late child ${round}`,
          parentPath: p.category.path,
        }),
      ]);
      const subtree = await repositories.categories.listSubtree(workspaceId, p.category.path);
      const parent = subtree.find((c) => c.id === p.category.id)!;
      if (parent.status === 'archived') {
        for (const c of subtree) {
          expect(c.status, `${c.path} under an archived parent`).toBe('archived');
        }
      }
    }
  });
});

describe('concurrent sign-in failures', () => {
  it('counts every parallel attempt, so the account locks', async () => {
    const attempts = MAX_FAILED_LOGINS + 5;
    await Promise.allSettled(
      Array.from({ length: attempts }, () => users.authenticate('owner@example.com', 'wrong')),
    );
    const user = await repositories.users.findByEmail('owner@example.com');
    // Before the counter became one statement, parallel attempts overwrote each
    // other and this stayed in the low single digits with no lockout at all.
    expect(user!.failedLoginCount).toBeGreaterThanOrEqual(MAX_FAILED_LOGINS);
    expect(user!.lockedUntil).not.toBeNull();
  });
});

describe('concurrent membership changes', () => {
  it('never removes the last owner, whatever the interleaving', async () => {
    for (let round = 0; round < 6; round += 1) {
      const emails = [`o1-${round}@example.com`, `o2-${round}@example.com`];
      const ws = await new WorkspaceService({
        uow: createUnitOfWork(handle.db),
        workspaces: repositories.workspaces,
        actors: repositories.actors,
        ledger: new EventLedger({ key, events: repositories.events }),
      }).create({ slug: `race-${round}`, name: `Race ${round}`, requestId: `w-${round}` });
      const system = (await repositories.actors.findSystemActor(ws.id))!;
      const ctx: ActorContext = {
        workspaceId: ws.id,
        actorId: system.id as ActorId,
        actorType: 'system',
        requestId: `r-${round}`,
      };
      const added: UserId[] = [];
      for (const email of emails) {
        const member = await members.add(
          ctx,
          {},
          {
            email,
            role: 'owner',
            initialPassword: PASSWORD,
          },
        );
        added.push(member.userId);
      }
      await Promise.allSettled(added.map((userId) => members.remove(ctx, {}, userId)));
      // Both removals used to read two owners and each remove one.
      expect(await repositories.memberships.countByRole(ws.id, 'owner')).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the database refuses what the domain would never write', () => {
  it('refuses a path that does not end in the slug, and a status nothing produces', async () => {
    const category = (
      await taxonomy.create(context('constraint-check'), { name: 'Constraint check' })
    ).category;
    // The path is the parent's path plus this slug. A lost rewrite used to
    // leave the two disagreeing, and nothing at the database level noticed.
    await expect(
      handle.db.execute(sql`UPDATE categories SET path = 'not-the-slug' WHERE id = ${category.id}`),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`UPDATE categories SET status = 'nonsense' WHERE id = ${category.id}`),
    ).rejects.toThrow();
    // A parent that is not a category is refused too.
    await expect(
      handle.db.execute(
        sql`UPDATE categories SET parent_id = 'cat_01M2XXXXXXXXXXXXXXXXXXXXXX' WHERE id = ${category.id}`,
      ),
    ).rejects.toThrow();
  });
});

describe('the tree written to the repository is the tree the database ends up with', () => {
  /**
   * The repository file is committed before PostgreSQL is written, so it is
   * rendered from a tree computed in memory. That is a second implementation
   * of what the SQL statements do, and two implementations of one rule drift.
   * Each case here applies a real mutation and compares the two.
   */
  /** Everything the file is able to say, in one comparable string. */
  const shape = (categories: readonly FlatCategory[]) =>
    categories
      .map((c) =>
        [
          c.path,
          c.slug,
          c.name,
          c.status,
          c.description ?? '-',
          c.aliases.join(','),
          c.inclusionGuidance.join('|'),
          c.exclusionGuidance.join('|'),
        ].join(' :: '),
      )
      .sort()
      .join('\n');

  const treeFromDatabase = async (): Promise<FlatCategory[]> => {
    const categories = await repositories.categories.list(workspaceId, { includeArchived: true });
    const aliases = await repositories.aliases.listForWorkspace(workspaceId);
    return categories.map((category) => ({
      path: category.path,
      slug: category.slug,
      name: category.name,
      status: category.status,
      description: category.description,
      aliases: sortedAliases(
        aliases.filter((a) => a.categoryId === category.id).map((a) => a.alias),
      ),
      inclusionGuidance: category.inclusionGuidance,
      exclusionGuidance: category.exclusionGuidance,
    }));
  };

  const readTaxonomyFile = () =>
    readFile(join(repoRoot, 'repositories', workspaceId, 'taxonomy.yaml'), 'utf8');

  const treeFromFile = async () => parseTaxonomy(await readTaxonomyFile());

  /**
   * The file parsed back and the database read out, compared field by field.
   *
   * Asserting that the database equals itself, or that the file merely mentions
   * each slug, passes whatever the file contains — including a category the
   * file has and the database does not.
   */
  const expectAgreement = async () => {
    const fromFile = await treeFromFile();
    expect(shape(fromFile.categories)).toBe(shape(await treeFromDatabase()));
    expect(fromFile.version).toBe(await repositories.taxonomyVersions.current(workspaceId));
  };

  it('agrees after a create, a rename, a move and an archive', async () => {
    const root = (await taxonomy.create(context('p-root'), { name: 'Projection root' })).category;
    const child = (
      await taxonomy.create(context('p-child'), {
        name: 'Projection child',
        parentPath: root.path,
      })
    ).category;
    const elsewhere = (await taxonomy.create(context('p-else'), { name: 'Projection elsewhere' }))
      .category;

    // After each mutation the file and the database describe the same tree.
    for (const mutate of [
      () =>
        taxonomy.update(context('p-rename'), {
          categoryId: root.id,
          slug: 'projection-renamed',
          description: 'A renamed root.',
          aliases: ['Zeta', 'Alpha', 'Mid'],
          inclusionGuidance: ['keep this'],
        }),
      () => taxonomy.move(context('p-move'), child.id, elsewhere.id),
      () => taxonomy.archive(context('p-archive'), elsewhere.id),
    ]) {
      await mutate();
      await expectAgreement();
    }
  });

  it('records the version and the commit together', async () => {
    const before = await repositories.taxonomyVersions.current(workspaceId);
    const result = await taxonomy.create(context('p-version'), { name: 'Projection version' });
    expect(result.taxonomyVersion).toBe(before + 1);
    // The file carries the version the database recorded for this change.
    expect((await treeFromFile()).version).toBe(result.taxonomyVersion);
  });

  it('leaves no unfinished operation behind', async () => {
    await taxonomy.create(context('p-clean'), { name: 'Projection clean' });
    expect(await repositories.operations.listUnfinished(workspaceId)).toHaveLength(0);
  });

  it('refuses a change that would alter nothing, rather than committing nothing', async () => {
    const category = (await taxonomy.create(context('p-noop'), { name: 'Projection noop' }))
      .category;
    // An empty commit would leave an operation pointing at no commit at all.
    await expect(taxonomy.move(context('p-noop-move'), category.id, null)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('a repository that lost its history', () => {
  it('is refused rather than written into', async () => {
    const workspace = await new WorkspaceService({
      uow,
      workspaces: repositories.workspaces,
      actors: repositories.actors,
      ledger: new EventLedger({ key, events: repositories.events }),
    }).create({ slug: 'lost-history', name: 'Lost history', requestId: 'lost' });
    const system = (await repositories.actors.findSystemActor(workspace.id))!;
    const ctx: ActorContext = {
      workspaceId: workspace.id,
      actorId: system.id as ActorId,
      actorType: 'system',
      requestId: 'lost-1',
    };
    await taxonomy.create(ctx, { name: 'Before the loss' });

    // The repository is gone: a lost volume, a restore of the database alone,
    // or somebody else's directory mounted in its place.
    await rm(join(repoRoot, 'repositories', workspace.id), { recursive: true, force: true });

    // Writing would start a fresh repository and build new history on top of a
    // hole, then call the result canonical.
    await expect(taxonomy.create(ctx, { name: 'After the loss' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
