import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { KnowledgeItemId, RevisionId, WorkspaceId } from '@knoverge/contracts';
import {
  EmbeddingService,
  EventLedger,
  UserService,
  WorkspaceService,
  parseLedgerKey,
} from '@knoverge/core';
import type { EmbeddingProvider } from '@knoverge/intelligence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('e'.repeat(64));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let repositories: ReturnType<typeof createRepositories>;
let uow: ReturnType<typeof createUnitOfWork>;
let workspaceId: WorkspaceId;

/** A provider that answers with a fixed shape and counts what it was asked. */
function stubProvider(model: string, dimensions: number) {
  let asked = 0;
  const provider: EmbeddingProvider = {
    profile: { provider: 'stub', model, dimensions },
    embed: async (texts) => {
      asked += texts.length;
      return texts.map((_, i) => Array.from({ length: dimensions }, (_, d) => (i + d) / 100));
    },
  };
  return { provider, asked: () => asked };
}

/** Chunks, written straight in: this is about what happens to them afterwards. */
async function chunksFor(count: number): Promise<void> {
  const now = new Date();
  await uow.run((tx) =>
    repositories.search.upsert(tx, {
      knowledgeItemId: 'kn_01M2XEMBEDEMBEDEMBEDEMBED1' as KnowledgeItemId,
      workspaceId,
      revisionId: 'rev_01M2XEMBEDEMBEDEMBEDEMBED1' as RevisionId,
      language: 'en',
      title: 'Embedded item',
      chunks: Array.from({ length: count }, (_, ordinal) => ({
        ordinal,
        text: `Paragraph number ${ordinal}.`,
      })),
      updatedAt: now,
    }),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 4 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);
  repositories = createRepositories(handle.db);
  uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({ key, events: repositories.events });
  const users = new UserService({
    sessions: repositories.sessions,
    uow,
    users: repositories.users,
    passwords: {
      hash: async (p) => `hashed:${p}`,
      verify: async () => true,
      dummyHash: async () => 'hashed:x',
    },
  });
  void users;
  const workspace = await new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  }).create({ slug: 'embedded', name: 'Embedded', requestId: 'setup' });
  workspaceId = workspace.id;
  // The chunk rows reference an item, so one has to exist for the foreign key.
  await handle.pool.query(
    `insert into knowledge_items (id, workspace_id, slug, markdown_path, type, status, language,
       current_revision_id, review_state, evidence_state, disputed, created_by_actor_id,
       created_at, updated_at)
     select $1, $2::varchar, 'embedded-item',
       'knowledge/_uncategorised/embedded-item.md', 'fact', 'active', 'en', null,
       'unreviewed', 'none', false, a.id, now(), now()
     from actors a where a.workspace_id = $2::varchar limit 1`,
    ['kn_01M2XEMBEDEMBEDEMBEDEMBED1', workspaceId],
  );
}, 180_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
});

describe('with no provider configured', () => {
  it('does nothing at all, which is what rule 9 asks for', async () => {
    await chunksFor(3);
    const service = new EmbeddingService({
      uow,
      embeddings: repositories.embeddings,
      provider: null,
    });
    expect(await service.fill(workspaceId)).toEqual({ embedded: 0, remaining: 0 });
    expect(await service.activeProfile(workspaceId)).toBeNull();
  });
});

describe('filling a workspace', () => {
  it('embeds a batch at a time and says what is left', async () => {
    await chunksFor(5);
    const { provider, asked } = stubProvider('first-model', 4);
    const service = new EmbeddingService({ uow, embeddings: repositories.embeddings, provider });

    const first = await service.fill(workspaceId, 2);
    expect(first).toMatchObject({ embedded: 2, remaining: 3 });
    // The first profile in a workspace answers at once: there is nothing for
    // it to take over from.
    expect(await service.activeProfile(workspaceId)).toMatchObject({
      model: 'first-model',
      dimensions: 4,
      status: 'active',
    });

    await service.fill(workspaceId, 2);
    const last = await service.fill(workspaceId, 2);
    expect(last).toMatchObject({ embedded: 1, remaining: 0 });
    expect(asked()).toBe(5);

    // Asking again embeds nothing: a pass touches only chunks with no vector,
    // which is what makes a dropped job cost a delay rather than an answer.
    expect(await service.fill(workspaceId, 2)).toMatchObject({ embedded: 0, remaining: 0 });
  });

  it('loses the vectors when the chunks they described are rewritten', async () => {
    // A vector for text that no longer exists is worse than none.
    const { provider } = stubProvider('first-model', 4);
    const service = new EmbeddingService({ uow, embeddings: repositories.embeddings, provider });
    await chunksFor(2);
    expect(await service.fill(workspaceId)).toMatchObject({ embedded: 2, remaining: 0 });
    const rows = await handle.pool.query('select count(*)::int as n from embeddings');
    expect(rows.rows[0].n).toBe(2);
  });
});

describe('changing the model', () => {
  it('keeps answering from the old vectors until the new ones are complete', async () => {
    await chunksFor(4);
    const first = stubProvider('first-model', 4);
    await new EmbeddingService({
      uow,
      embeddings: repositories.embeddings,
      provider: first.provider,
    }).fill(workspaceId);

    const second = stubProvider('second-model', 8);
    const service = new EmbeddingService({
      uow,
      embeddings: repositories.embeddings,
      provider: second.provider,
    });

    // Half way through: the new profile is being built, and the one queries
    // use is still the old one. Otherwise a workspace of fifty thousand
    // chunks answers nothing useful for as long as the re-embedding takes.
    await service.fill(workspaceId, 2);
    expect(await service.activeProfile(workspaceId)).toMatchObject({ model: 'first-model' });
    expect(await repositories.embeddings.rebuilding(workspaceId)).toMatchObject({
      model: 'second-model',
      status: 'rebuilding',
    });

    const done = await service.fill(workspaceId, 10);
    expect(done.remaining).toBe(0);
    expect(done.promoted).toBeDefined();
    // They change places when the last chunk is embedded.
    expect(await service.activeProfile(workspaceId)).toMatchObject({ model: 'second-model' });
    expect(await repositories.embeddings.rebuilding(workspaceId)).toBeNull();
  });
});
