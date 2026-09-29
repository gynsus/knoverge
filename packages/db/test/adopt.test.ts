import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { WorkspaceId } from '@knoverge/contracts';
import {
  AdoptService,
  CrossStoreWriter,
  EventLedger,
  KnowledgeService,
  WorkspaceService,
  keyring,
  parseLedgerKey,
  type ActorContext,
} from '@knoverge/core';
import {
  contentHash,
  createGitStore,
  frontmatterHash,
  parseItem,
  renderItem,
  repositoryPath,
  slugifyTitle,
  uniqueSlug,
} from '@knoverge/git-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const run = promisify(execFile);
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let dataDir: string;
let workspaceId: WorkspaceId;
let actor: ActorContext;
let repositories: ReturnType<typeof createRepositories>;
let adopt: AdoptService;
let knowledge: KnowledgeService;
let repo: string;

/** A commit made the way a person makes one: their editor, their git. */
async function commitByHand(message: string): Promise<void> {
  await run('git', ['-C', repo, 'add', '--all']);
  await run('git', ['-C', repo, 'commit', '--quiet', '--message', message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Grigory Frolov',
      GIT_AUTHOR_EMAIL: 'owner@example.com',
      GIT_COMMITTER_NAME: 'Grigory Frolov',
      GIT_COMMITTER_EMAIL: 'owner@example.com',
    },
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 6 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-adopt-'));
  repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({
    key: keyring(parseLedgerKey('a1'.repeat(32))),
    events: repositories.events,
  });
  const git = createGitStore({ dataDir });

  const workspace = await new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  }).create({ slug: 'personal', name: 'Personal', requestId: 'req-setup' });
  workspaceId = workspace.id;
  repo = repositoryPath(dataDir, workspaceId);
  actor = {
    workspaceId,
    actorId: (await repositories.actors.findSystemActor(workspaceId))!.id,
    actorType: 'system',
    requestId: 'req-adopt',
    client: 'test-suite',
  } as ActorContext;

  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
  });
  knowledge = new KnowledgeService({
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
    workspaces: {
      findById: async (id: WorkspaceId) => {
        const found = await repositories.workspaces.findById(id);
        return found
          ? { id: found.id, name: found.name, defaultLanguage: found.defaultLanguage }
          : null;
      },
    },
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
  adopt = new AdoptService({
    uow,
    items: repositories.knowledge,
    revisions: repositories.revisions,
    categories: repositories.categories,
    relations: repositories.relations,
    sources: repositories.sources,
    summaries: repositories.summaries,
    search: repositories.search,
    operations: repositories.operations,
    ledger,
    git,
    parseItem,
    contentHash,
    frontmatterHash,
  });

  // One item written the ordinary way, so the repository exists and the
  // database knows where its history stands.
  await knowledge.create(actor, {
    title: 'Escalation path',
    body: 'Support first.',
    type: 'document',
  });
}, 240_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('a commit somebody made by hand', () => {
  it('is adopted as an update, with the file as the record of what changed', async () => {
    const path = join(repo, 'knowledge/_uncategorised/escalation-path.md');
    const before = await readFile(path, 'utf8');
    await writeFile(path, before.replace('Support first.', 'Support first, then on-call.'), 'utf8');
    await commitByHand('fix the escalation path');

    const result = await adopt.run(workspaceId, actor);
    expect(result).toMatchObject({ commits: 1, created: 0, updated: 1 });

    const items = await repositories.knowledge.list(workspaceId, { limit: 10 });
    const history = await repositories.revisions.listForItem(items[0]!.id, 10);
    // Two revisions: the one the product wrote and the one the person did.
    expect(history).toHaveLength(2);
    expect(history[0]?.changeKind).toBe('update');
    expect(history[0]?.contentHash).toBe(
      contentHash('Escalation path', 'Support first, then on-call.\n'),
    );
  });

  it('is adopted as a create when the file is one the workspace has never seen', async () => {
    const file = join(repo, 'knowledge/_uncategorised/written-by-hand.md');
    await writeFile(
      file,
      [
        '---',
        'id: kn_01M3P9ZZZZZZZZZZZZZZZZZZZZ',
        'title: Written by hand',
        'type: document',
        'status: active',
        'language: en',
        'created_at: 2026-09-29T10:00:00Z',
        'updated_at: 2026-09-29T10:00:00Z',
        '---',
        '',
        'Somebody wrote this in an editor.',
        '',
      ].join('\n'),
      'utf8',
    );
    await commitByHand('add a note by hand');

    const result = await adopt.run(workspaceId, actor);
    expect(result).toMatchObject({ commits: 1, created: 1, updated: 0 });

    // The file says which item it is, because an external commit carries no
    // trailers to read it out of (ADR 0037).
    const item = await repositories.knowledge.findById(
      workspaceId,
      'kn_01M3P9ZZZZZZZZZZZZZZZZZZZZ' as never,
    );
    expect(item?.markdownPath).toBe('knowledge/_uncategorised/written-by-hand.md');
    // And it is searchable, which is what makes adoption worth anything.
    const found = await repositories.search.lexical(
      { workspaceId, text: 'wrote this in an editor' },
      5,
    );
    expect(found.map((row) => row.itemId)).toContain(item?.id);
  });

  it('says it is the installation noticing, not somebody using the product', async () => {
    const events = await repositories.events.listAfter(workspaceId, 0, 100);
    const adopted = events.filter((event) => event.metadata?.['adopted'] === true);
    expect(adopted.length).toBeGreaterThan(0);
    // The commit is on the event, so the Git author — the person who actually
    // made the change — is one lookup away.
    expect(adopted.every((event) => typeof event.metadata?.['git_commit'] === 'string')).toBe(true);
  });

  it('adopts nothing the second time, because there is nothing left it has not heard of', async () => {
    expect(await adopt.run(workspaceId, actor)).toMatchObject({
      commits: 0,
      created: 0,
      updated: 0,
    });
  });

  it('leaves alone a commit this product made, even between two that it did not', async () => {
    // The product writes between hand-made commits all the time, and adopting
    // its own commit would write a second revision for a change already
    // recorded — with a new id, so the history would say it happened twice.
    const written = await knowledge.create(actor, {
      title: 'Written the ordinary way',
      body: 'Through the product.',
      type: 'document',
    });
    await writeFile(
      join(repo, 'knowledge/_uncategorised/after-the-product.md'),
      [
        '---',
        'id: kn_01M3PBBBBBBBBBBBBBBBBBBBBB',
        'title: After the product',
        'type: document',
        'status: active',
        'language: en',
        'created_at: 2026-09-29T11:00:00Z',
        'updated_at: 2026-09-29T11:00:00Z',
        '---',
        '',
        'Written by hand after.',
        '',
      ].join('\n'),
      'utf8',
    );
    await commitByHand('another one by hand');

    const result = await adopt.run(workspaceId, actor);
    // One commit adopted, not two: the product's own is already recorded.
    expect(result).toMatchObject({ commits: 1, created: 1, updated: 0 });
    expect(await repositories.revisions.listForItem(written.item.id, 10)).toHaveLength(1);
  });

  it('finds a hand-made commit that the product committed on top of', async () => {
    // The order that breaks a range: the product writes, somebody commits by
    // hand, the product writes again. The newest commit the database knows is
    // then *after* the hand-made one, so "everything since the newest known"
    // would skip it entirely and the workspace would stay wrong for ever.
    await writeFile(
      join(repo, 'knowledge/_uncategorised/in-between.md'),
      [
        '---',
        'id: kn_01M3PCCCCCCCCCCCCCCCCCCCCC',
        'title: In between',
        'type: document',
        'status: active',
        'language: en',
        'created_at: 2026-09-29T12:00:00Z',
        'updated_at: 2026-09-29T12:00:00Z',
        '---',
        '',
        'Committed by hand, then committed on top of.',
        '',
      ].join('\n'),
      'utf8',
    );
    await commitByHand('by hand, before the product writes again');
    await knowledge.create(actor, {
      title: 'On top of it',
      body: 'Written through the product afterwards.',
      type: 'document',
    });

    const result = await adopt.run(workspaceId, actor);
    expect(result.created).toBe(1);
    expect(
      await repositories.knowledge.findById(workspaceId, 'kn_01M3PCCCCCCCCCCCCCCCCCCCCC' as never),
    ).not.toBeNull();
  });

  it('records nothing for a commit that changed nothing about the knowledge', async () => {
    const path = join(repo, 'knowledge/_uncategorised/escalation-path.md');
    const before = await readFile(path, 'utf8');
    // Trailing whitespace, which normalisation removes: the file changed and
    // the knowledge did not (GIT_REPOSITORY.md section 5).
    await writeFile(path, before.replace('then on-call.', 'then on-call.   '), 'utf8');
    await commitByHand('whitespace');

    const result = await adopt.run(workspaceId, actor);
    expect(result.commits).toBe(1);
    // A revision that says nothing happened is worse than no revision.
    expect(result.updated).toBe(0);
    expect(result.skipped).toContainEqual({
      path: 'knowledge/_uncategorised/escalation-path.md',
      why: 'nothing about it changed',
    });
  });

  it('names a file it cannot read rather than guessing what it is', async () => {
    await writeFile(
      join(repo, 'knowledge/_uncategorised/not-an-item.md'),
      '# Just a heading\n\nNo frontmatter at all.\n',
      'utf8',
    );
    await commitByHand('add something that is not an item');

    const result = await adopt.run(workspaceId, actor);
    // Inventing an id for somebody's file would be inventing the thing the file
    // was supposed to say.
    expect(result.created).toBe(0);
    const named = result.skipped.find(
      (skip) => skip.path === 'knowledge/_uncategorised/not-an-item.md',
    );
    expect(named?.why).toMatch(/frontmatter/u);
  });

  it('refuses a repository whose history was rewritten', async () => {
    // The workspace's newest recorded commit is no longer in the branch, so
    // this is not the history these records describe.
    const root = (
      await run('git', ['-C', repo, 'rev-list', '--max-parents=0', 'HEAD'])
    ).stdout.trim();
    await run('git', ['-C', repo, 'checkout', '--quiet', '-b', 'rewritten', root]);
    try {
      await expect(adopt.run(workspaceId, actor)).rejects.toThrow(/rewrote it/u);
    } finally {
      await run('git', ['-C', repo, 'checkout', '--quiet', 'main']);
      await run('git', ['-C', repo, 'branch', '-D', 'rewritten']);
    }
  });
});
