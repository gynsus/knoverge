import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, CategoryId, UserId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import {
  AuthorizationService,
  BootstrapService,
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
let actor: ActorContext;

const context = (requestId: string): ActorContext => ({ ...actor, requestId });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 16 });
  await runMigrations(handle.db, migrationsFolder);
  repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
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
  taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
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
  await handle?.close();
  await container?.stop();
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
