import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import {
  CrossStoreWriter,
  EventLedger,
  ExportService,
  ImportService,
  KnowledgeService,
  TaxonomyService,
  WorkspaceService,
  keyring,
  newId,
  parseLedgerKey,
} from '@knoverge/core';
import {
  TAXONOMY_PATH,
  contentHash,
  createGitStore,
  frontmatterHash,
  parseItem,
  parseTaxonomy,
  renderItem,
  renderTaxonomy,
  slugifyTitle,
  uniqueSlug,
} from '@knoverge/git-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
/**
 * The receiving installation, as its own database.
 *
 * Not another workspace in the same one: item ids are globally unique and
 * survive an export, so an import into the installation that still holds them
 * is refused — which is the point, and is its own test below.
 */
let theirs: DatabaseHandle;
let theirRepositories: ReturnType<typeof createRepositories>;
let dataDir: string;
let exportDir: string;
let sourceWorkspace: WorkspaceId;
let actor: ActorContext;
let repositories: ReturnType<typeof createRepositories>;
let exports_: ExportService;
let imports: ImportService;
let git: ReturnType<typeof createGitStore>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-import-data-'));
  exportDir = await mkdtemp(join(tmpdir(), 'knoverge-import-out-'));
  repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({
    key: keyring(parseLedgerKey('a1'.repeat(32))),
    events: repositories.events,
  });
  git = createGitStore({ dataDir });

  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  const source = await workspaces.create({
    slug: 'personal',
    name: 'Personal',
    requestId: 'req-export',
  });
  sourceWorkspace = source.id;
  // A person's actor, inserted directly: what matters here is that the commits
  // name somebody with a display name, not how they signed in.
  const human = newId('act') as ActorContext['actorId'];
  await uow.run((tx) =>
    repositories.actors.insert(tx, {
      id: human,
      workspaceId: sourceWorkspace,
      type: 'human',
      displayName: 'Grigory Frolov',
      userId: null,
      agentId: null,
      createdAt: new Date(),
      disabledAt: null,
    }),
  );
  actor = {
    workspaceId: sourceWorkspace,
    actorId: human,
    actorType: 'human',
    requestId: 'req-export',
    client: 'test-suite',
  } as ActorContext;

  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
  });
  const lookupWorkspace = {
    findById: async (id: WorkspaceId) => {
      const workspace = await repositories.workspaces.findById(id);
      return workspace
        ? { id: workspace.id, name: workspace.name, defaultLanguage: workspace.defaultLanguage }
        : null;
    },
  };
  const knowledge = new KnowledgeService({
    uow,
    items: repositories.knowledge,
    revisions: repositories.revisions,
    sources: repositories.sources,
    relations: repositories.relations,
    summaries: repositories.summaries,
    search: repositories.search,
    categories: repositories.categories,
    versions: repositories.taxonomyVersions,
    actors: repositories.actors,
    workspaces: lookupWorkspace,
    ledger,
    crossStore,
    git,
    slugifyTitle,
    uniqueSlug,
    renderItem,
    parseItem,
    contentHash,
    frontmatterHash,
  });
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
    references: async () => ({ proposals: 0, grants: 0, policyRules: 0 }),
    items: repositories.knowledge,
    parseItem,
    renderItem,
    uniqueSlug,
    workspaces: lookupWorkspace,
    actors: repositories.actors,
  });

  // A workspace with a shape worth carrying: a category, an item that was
  // written twice, one that cites a source, and one that was deleted.
  await taxonomy.create(actor, { name: 'Operations' });
  const runbook = await knowledge.create(actor, {
    title: 'Escalation path',
    body: 'Support first.',
    type: 'procedure',
    categories: ['operations'],
  });
  await knowledge.update(actor, {
    itemId: runbook.item.id,
    baseRevisionId: runbook.revision.id,
    baseContentHash: runbook.revision.contentHash,
    body: 'Support first, then the on-call engineer.',
    reason: 'the rota changed',
  });
  await knowledge.create(actor, {
    title: 'What the spec says',
    body: 'It says what it says.',
    type: 'fact',
    sources: [{ type: 'web_url', uri: 'https://example.com/spec', role: 'primary' }],
  });
  const doomed = await knowledge.create(actor, {
    title: 'A note that did not last',
    body: 'Briefly true.',
    type: 'fact',
  });
  await knowledge.delete(actor, {
    itemId: doomed.item.id,
    baseRevisionId: doomed.revision.id,
    baseContentHash: doomed.revision.contentHash,
    reason: 'no longer true',
  });

  exports_ = new ExportService({
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    knowledge: repositories.knowledge,
    attachments: repositories.attachments,
    events: repositories.events,
  });
  // The export itself, written the way `knoverge export` writes it.
  const described = await exports_.describe(sourceWorkspace, {
    takenBy: 'test',
    withAttachments: false,
  });
  await git.bundle(sourceWorkspace, join(exportDir, 'repository.bundle'));
  await writeFile(
    join(exportDir, 'manifest.json'),
    JSON.stringify(described.manifest, null, 2),
    'utf8',
  );

  // And the installation it lands in: another database, the way another
  // installation would be.
  await handle.db.execute(sql`CREATE DATABASE receiving`);
  theirs = createDatabase({
    connectionString: container.getConnectionUri().replace(/\/[^/]+$/u, '/receiving'),
    max: 6,
  });
  theirs.pool.on('error', () => undefined);
  await runMigrations(theirs.db, migrationsFolder);
  theirRepositories = createRepositories(theirs.db);
  const theirUow = createUnitOfWork(theirs.db);
  const theirLedger = new EventLedger({
    key: keyring(parseLedgerKey('a1'.repeat(32))),
    events: theirRepositories.events,
  });
  const theirWorkspaces = new WorkspaceService({
    uow: theirUow,
    workspaces: theirRepositories.workspaces,
    actors: theirRepositories.actors,
    ledger: theirLedger,
  });
  imports = new ImportService({
    uow: theirUow,
    actors: theirRepositories.actors,
    items: theirRepositories.knowledge,
    revisions: theirRepositories.revisions,
    categories: theirRepositories.categories,
    relations: theirRepositories.relations,
    sources: theirRepositories.sources,
    summaries: theirRepositories.summaries,
    search: theirRepositories.search,
    operations: theirRepositories.operations,
    attachments: theirRepositories.attachments,
    aliases: theirRepositories.aliases,
    versions: theirRepositories.taxonomyVersions,
    ledger: theirLedger,
    git,
    parseItem,
    parseTaxonomy,
    taxonomyPath: TAXONOMY_PATH,
    contentHash,
    frontmatterHash,
  });
  const target = await theirWorkspaces.create({
    slug: 'imported',
    name: 'Imported',
    requestId: 'req-import',
  });
  await git.cloneFromBundle(target.id, join(exportDir, 'repository.bundle'));
  const into = {
    workspaceId: target.id,
    actorId: (await theirRepositories.actors.findSystemActor(target.id))!.id,
    actorType: 'system',
    requestId: 'req-import',
    client: 'test-suite',
  } as ActorContext;
  const manifest = JSON.parse(
    await readFile(join(exportDir, 'manifest.json'), 'utf8'),
  ) as Parameters<ImportService['recreateActors']>[1];
  imports.check(manifest);
  await imports.expectEmpty(target.id);
  const map = await imports.recreateActors(target.id, manifest);
  await imports.restoreTaxonomy(target.id, into);
  // This workspace holds no files, so nothing is asked of a store — the copying
  // is covered where the store lives, in the command line's own tests.
  await imports.restoreAttachments(target.id, into, manifest, async () => false);
  await imports.replay(target.id, into, map);
  importedWorkspace = target.id;
  importedBy = into;
}, 240_000);

let importedWorkspace: WorkspaceId;
let importedBy: ActorContext;

afterAll(async () => {
  await theirs?.close().catch(() => undefined);
  await handle?.close().catch(() => undefined);
  await container?.stop();
  for (const dir of [dataDir, exportDir]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe('a workspace that came back from an export', () => {
  it('holds the same items, under the same ids', async () => {
    const there = await repositories.knowledge.list(sourceWorkspace, { limit: 100 });
    const here = await theirRepositories.knowledge.list(importedWorkspace, { limit: 100 });
    // Ids survive, because they are the knowledge: it is what makes two
    // workspaces holding one id comparable (ADR 0035).
    expect(here.map((item) => item.id).sort()).toEqual(there.map((item) => item.id).sort());
    expect(here.every((item) => item.workspaceId === importedWorkspace)).toBe(true);
  });

  it('keeps the history, not only where the items ended up', async () => {
    const [item] = (
      await theirRepositories.knowledge.list(importedWorkspace, { limit: 100 })
    ).filter((candidate) => candidate.markdownPath.includes('escalation-path'));
    const history = await theirRepositories.revisions.listForItem(item!.id, 50);
    // Written twice there, so twice here: an import that wrote only the current
    // state would leave a workspace whose past exists on disk and nowhere a
    // reader can reach.
    expect(history).toHaveLength(2);
    expect(history.map((revision) => revision.changeKind)).toEqual(['update', 'create']);
    expect(history.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
  });

  it('keeps the provenance, as rows and not only as frontmatter', async () => {
    const [item] = (
      await theirRepositories.knowledge.list(importedWorkspace, { limit: 100 })
    ).filter((candidate) => candidate.markdownPath.includes('what-the-spec-says'));
    const cited = await theirRepositories.sources.forRevision(item!.currentRevisionId as never);
    expect(cited.map((source) => [source.sourceType, source.uri])).toEqual([
      ['web_url', 'https://example.com/spec'],
    ]);
  });

  it('keeps the taxonomy, and the items know which category they are in', async () => {
    const tree = await theirRepositories.categories.list(importedWorkspace, {});
    expect(tree.map((category) => category.path)).toEqual(['operations']);
    const [item] = (
      await theirRepositories.knowledge.list(importedWorkspace, { limit: 100 })
    ).filter((candidate) => candidate.markdownPath.includes('escalation-path'));
    const links = await theirRepositories.knowledge.categoriesOf(importedWorkspace, [item!.id]);
    const operations = tree.find((category) => category.path === 'operations');
    // The item points at the category this workspace's tree has, not at an id
    // from the installation it came from.
    expect(links.map((link) => link.categoryId)).toEqual([operations!.id]);
    expect(links[0]?.isPrimary).toBe(true);
  });

  it('carries a delete across as a delete', async () => {
    const all = await theirRepositories.knowledge.list(importedWorkspace, {
      limit: 100,
      status: 'deleted',
    });
    const gone = all[0];
    // The file is gone from the working tree and the row says why, which is
    // what a logical delete is.
    expect(gone).toBeTruthy();
    expect(gone?.deletedAt).not.toBeNull();
  });

  it('says who wrote what, and lets none of them write again', async () => {
    const actors = await theirRepositories.actors.listForWorkspace(importedWorkspace);
    const recreated = actors.filter((candidate) => candidate.displayName === 'Grigory Frolov');
    expect(recreated).toHaveLength(1);
    // Nobody here: an actor with no user and no agent behind it names who wrote
    // something and grants nothing (ADR 0035).
    expect(recreated[0]?.userId).toBeNull();
    expect(recreated[0]?.agentId).toBeNull();
    // And the ids are this installation's, so the same export imported twice
    // does not collide on a primary key.
    const there = await repositories.actors.listForWorkspace(sourceWorkspace);
    expect(recreated[0]?.id).not.toBe(there.find((a) => a.displayName === 'Grigory Frolov')?.id);
  });

  it('refuses a second import into the same workspace', async () => {
    // Merging two workspaces that may share item ids is a reconciliation, and
    // doing it silently is the blind insert this milestone exists to avoid.
    await expect(imports.expectEmpty(importedWorkspace)).rejects.toThrow(/already holds/u);
  });

  it('starts its own ledger rather than adopting one it cannot verify', async () => {
    const events = await theirRepositories.events.listAfter(importedWorkspace, 0, 200);
    expect(events[0]?.eventType).toBe('workspace.created');
    // One per item that arrived, attributed to whoever ran the import, and
    // saying what it was.
    const imported = events.filter((event) => event.metadata?.['imported'] === true);
    // One per item that arrived — three were written, one of which was later
    // deleted, and the delete is a revision rather than a second arrival.
    expect(imported).toHaveLength(3);
    expect(imported.every((event) => event.actorId === importedBy.actorId)).toBe(true);
  });
});
