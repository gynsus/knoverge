import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext, CrossStoreWriter as Writer } from '@knoverge/core';
import {
  BootstrapService,
  CrossStoreWriter,
  EventLedger,
  KnowledgeRecovery,
  KnowledgeService,
  RecoveryService,
  TaxonomyService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
} from '@knoverge/core';
import {
  TAXONOMY_PATH,
  contentHash,
  createGitStore,
  frontmatterHash,
  parseItem,
  renderItem,
  renderTaxonomy,
  slugifyTitle,
  uniqueSlug,
} from '@knoverge/git-store';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

/**
 * The failure the whole cross-store primitive exists for: the commit is made
 * and the process stops before PostgreSQL hears about it. The plan requires
 * this to be simulated rather than reasoned about.
 */
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('a7'.repeat(32));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let repoRoot: string;
let workspaceId: WorkspaceId;
let actor: ActorContext;
let repositories: ReturnType<typeof createRepositories>;
let knowledge: KnowledgeService;
let crashing: KnowledgeService;
let recovery: RecoveryService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({ key, events: repositories.events });
  const created = await new BootstrapService({
    uow,
    users: new UserService({
      uow,
      users: repositories.users,
      sessions: repositories.sessions,
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
  actor = {
    workspaceId,
    actorId: (await repositories.actors.findSystemActor(workspaceId))!.id as ActorId,
    actorType: 'human',
    requestId: 'req-crash',
    client: 'test-suite',
    sessionId: 'sess-crash',
  };

  repoRoot = await mkdtemp(join(tmpdir(), 'knoverge-recovery-'));
  const git = createGitStore({ dataDir: repoRoot });
  const workspaces = {
    findById: async (id: WorkspaceId) => {
      const workspace = await repositories.workspaces.findById(id);
      return workspace ? { id: workspace.id, name: workspace.name } : null;
    },
  };
  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
  });
  const shared = {
    uow,
    items: repositories.knowledge,
    revisions: repositories.revisions,
    sources: repositories.sources,
    relations: repositories.relations,
    categories: repositories.categories,
    versions: repositories.taxonomyVersions,
    actors: repositories.actors,
    workspaces,
    ledger,
    git,
    slugifyTitle,
    uniqueSlug,
    renderItem,
    parseItem,
    contentHash,
    frontmatterHash,
  };
  knowledge = new KnowledgeService({ ...shared, crossStore });

  // The same service, with a writer whose database step never runs. The commit
  // is real; everything after it is what a killed process loses.
  const stopsAfterCommit: Writer = {
    run: ((who: ActorContext, write: Parameters<Writer['run']>[1]) =>
      crossStore.run(who, {
        ...write,
        record: async () => {
          throw new Error('the process stops here');
        },
      })) as Writer['run'],
  } as unknown as Writer;
  crashing = new KnowledgeService({ ...shared, crossStore: stopsAfterCommit });

  const taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
    crossStore,
    git,
    renderTaxonomy,
    taxonomyPath: TAXONOMY_PATH,
    workspaces,
    actors: repositories.actors,
  });
  await taxonomy.create(actor, { name: 'Architecture' });

  recovery = new RecoveryService({
    uow,
    operations: repositories.operations,
    commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
    completeFromCommit: (operation) =>
      new KnowledgeRecovery({
        uow,
        items: repositories.knowledge,
        revisions: repositories.revisions,
        categories: repositories.categories,
        ledger,
        git,
        parseItem,
        contentHash,
        frontmatterHash,
      }).complete(operation),
  });
}, 180_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

describe('a create that reached Git and no further', () => {
  it('leaves the stores disagreeing, and recovery makes them agree', async () => {
    await expect(
      crashing.create(actor, {
        title: 'Survives a crash',
        body: 'Written to Git, never written to PostgreSQL.',
        type: 'decision',
        categories: ['architecture'],
        tags: ['recovery'],
      }),
    ).rejects.toThrow('the process stops here');

    // Git has it. PostgreSQL does not.
    const unfinished = await repositories.operations.listUnfinished(workspaceId);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]!.state).toBe('git_committed');
    const itemId = unfinished[0]!.objectIds['knowledge_item'] as string;
    expect(await repositories.knowledge.findById(workspaceId, itemId as never)).toBeNull();

    // And the workspace refuses to be written to while they disagree.
    await expect(
      knowledge.create(actor, { title: 'Blocked', body: 'Body.', type: 'fact' }),
    ).rejects.toThrow(/did not finish/);

    const report = await recovery.recover(workspaceId);
    expect(report.recovered, JSON.stringify(report)).toEqual([unfinished[0]!.id]);

    // The item is there, at the revision the commit named, with what the file
    // said — including the category and the tag, which only the file knew.
    const item = await repositories.knowledge.findById(workspaceId, itemId as never);
    expect(item).toMatchObject({ status: 'active', slug: 'survives-a-crash' });
    const revisions = await repositories.revisions.listForItem(itemId as never);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revisionNumber: 1, changeKind: 'create' });
    expect(revisions[0]!.gitCommitHash).toBe(unfinished[0]!.gitCommitHash);
    const tags = await repositories.knowledge.tagsOf(workspaceId, [itemId as never]);
    expect(tags.get(itemId as never)).toEqual(['recovery']);

    // The event records the request context the trailers never carried, and
    // says it was recovered rather than pretending the request finished.
    const events = await repositories.events.listAfter(workspaceId, 0, 100);
    const event = events.find((e) => e.eventType === 'knowledge.created');
    expect(event).toMatchObject({ requestId: 'req-crash', client: 'test-suite' });
    expect(event?.metadata).toMatchObject({ recovered: true });

    // And the workspace takes writes again.
    await expect(
      knowledge.create(actor, { title: 'Unblocked', body: 'Body.', type: 'fact' }),
    ).resolves.toBeTruthy();
  });

  it('is safe to run twice', async () => {
    await expect(
      crashing.create(actor, { title: 'Twice over', body: 'Body.', type: 'fact' }),
    ).rejects.toThrow('the process stops here');
    const [operation] = await repositories.operations.listUnfinished(workspaceId);
    const itemId = operation!.objectIds['knowledge_item'] as string;

    expect((await recovery.recover(workspaceId)).recovered).toEqual([operation!.id]);
    // Recovery runs at every startup, so a second pass must not write a second
    // revision for a commit that already has one.
    await handle.db.execute(
      sql`UPDATE operations SET state = 'git_committed' WHERE id = ${operation!.id}`,
    );
    const second = await recovery.recover(workspaceId);
    expect(second.recovered).toEqual([operation!.id]);
    expect(await repositories.revisions.listForItem(itemId as never)).toHaveLength(1);
  });
});
