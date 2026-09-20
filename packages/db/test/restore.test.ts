import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import {
  BootstrapService,
  CrossStoreWriter,
  EventLedger,
  TaxonomyService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
  sortedAliases,
} from '@knoverge/core';
import {
  TAXONOMY_PATH,
  createGitStore,
  parseTaxonomy,
  renderTaxonomy,
  type FlatCategory,
} from '@knoverge/git-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

/**
 * A backup nobody has restored is not a backup.
 *
 * This runs the drill the deployment guide describes, against a real database:
 * take a dump, restore it somewhere else, and check that what comes back is
 * the same knowledge base — the ledger chain still verifies, and the taxonomy
 * agrees with the repository the backup archived alongside it.
 */
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('e'.repeat(64));
const DUMP_PATH = '/tmp/knoverge-restore-drill.dump';
const RESTORED_DB = 'restore_drill';

let container: StartedPostgreSqlContainer;
let live: DatabaseHandle;
let restored: DatabaseHandle;
let repoRoot: string;
let workspaceId: WorkspaceId;

/** Everything the two sides have to agree on, in one comparable string. */
const shape = (categories: readonly FlatCategory[]) =>
  categories
    .map((c) => [c.path, c.slug, c.name, c.status, c.aliases.join(',')].join(' :: '))
    .sort()
    .join('\n');

async function inContainer(command: string[]): Promise<string> {
  const result = await container.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited ${result.exitCode}: ${result.output}`);
  }
  return result.output;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  live = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  live.pool.on('error', () => undefined);
  await runMigrations(live.db, migrationsFolder);

  const repositories = createRepositories(live.db);
  const uow = createUnitOfWork(live.db);
  const ledger = new EventLedger({ key, events: repositories.events });
  const created = await new BootstrapService({
    uow,
    users: new UserService({
      uow,
      users: repositories.users,
      // The drill is about what a restore brings back, not about hashing.
      passwords: {
        hash: async (p) => `hashed:${p}`,
        verify: async (p, h) => h === `hashed:${p}`,
        dummyHash: async () => 'hashed:__dummy__',
      },
    }),
    workspaces: new WorkspaceService({
      uow,
      workspaces: repositories.workspaces,
      actors: repositories.actors,
      ledger,
    }),
    memberships: repositories.memberships,
    actors: repositories.actors,
    ledger,
  }).run({
    user: {
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      displayName: 'Owner',
      locale: 'en',
    },
    workspace: { slug: 'personal', name: 'Personal' },
    requestId: 'bootstrap',
  });
  workspaceId = created.workspace.id;

  repoRoot = await mkdtemp(join(tmpdir(), 'knoverge-restore-'));
  const git = createGitStore({ dataDir: repoRoot });
  const taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
    crossStore: new CrossStoreWriter({
      uow,
      operations: repositories.operations,
      commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
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
  const actor: ActorContext = {
    workspaceId,
    actorId: (await repositories.actors.findSystemActor(workspaceId))!.id as ActorId,
    actorType: 'system',
    requestId: 'setup',
  };
  const root = (await taxonomy.create(actor, { name: 'Projects', aliases: ['Work', 'Delivery'] }))
    .category;
  await taxonomy.create(actor, { name: 'Pixel Brisbane', parentPath: root.path });

  // The order the backup script uses, and for the reason it documents: a write
  // commits to Git before PostgreSQL, so dumping the database first can only
  // leave the archive ahead of the dump, which recovery is built to resolve.
  await inContainer([
    'pg_dump',
    `--username=${container.getUsername()}`,
    `--dbname=${container.getDatabase()}`,
    '--format=custom',
    `--file=${DUMP_PATH}`,
  ]);

  await inContainer(['createdb', `--username=${container.getUsername()}`, RESTORED_DB]);
  await inContainer([
    'pg_restore',
    `--username=${container.getUsername()}`,
    `--dbname=${RESTORED_DB}`,
    DUMP_PATH,
  ]);
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${RESTORED_DB}`;
  restored = createDatabase({ connectionString: uri.toString(), max: 4 });
  restored.pool.on('error', () => undefined);
});

afterAll(async () => {
  await restored?.close().catch(() => undefined);
  await live?.close().catch(() => undefined);
  await container?.stop();
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

describe('restoring a backup', () => {
  it('brings back a ledger whose chain still verifies', async () => {
    const repositories = createRepositories(restored.db);
    const ledger = new EventLedger({ key, events: repositories.events });
    const report = await ledger.verify(workspaceId);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    // The chain is only meaningful if there is something in it: a restore that
    // produced an empty ledger would verify too.
    expect(report.count).toBeGreaterThan(0);
  });

  it('brings back a taxonomy that still matches the archived repository', async () => {
    const repositories = createRepositories(restored.db);
    const categories = await repositories.categories.list(workspaceId, { includeArchived: true });
    const aliases = await repositories.aliases.listForWorkspace(workspaceId);
    const fromDatabase = categories.map<FlatCategory>((category) => ({
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

    const file = parseTaxonomy(
      await readFile(join(repoRoot, 'repositories', workspaceId, TAXONOMY_PATH), 'utf8'),
    );
    expect(shape(file.categories)).toBe(shape(fromDatabase));
    expect(file.version).toBe(await repositories.taxonomyVersions.current(workspaceId));
  });

  it('brings back no unfinished operation, so the workspace accepts writes', async () => {
    // A restore that resurrected a pending row would close the workspace to
    // writes until an operator intervened, which is exactly the failure mode
    // the operation table exists to signal — so it must not be a false alarm.
    const repositories = createRepositories(restored.db);
    expect(await repositories.operations.listUnfinished(workspaceId)).toEqual([]);
    expect(await repositories.operations.workspacesUnfinished()).toEqual([]);
  });
});
