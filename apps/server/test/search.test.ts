import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TERMS_VERSION, KnowledgeSearchResponse } from '@knoverge/contracts';
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

const search = (payload: Record<string, unknown>) => admin.post('/v1/knowledge_search', payload);

async function create(payload: Record<string, unknown>) {
  const res = await admin.post('/v1/admin/knowledge.create', payload);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { item: Record<string, string> }).item as {
    id: string;
    current_revision_id: string;
    content_hash: string;
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
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
  expect(
    (
      await admin.post('/v1/bootstrap', {
        email: 'owner@example.com',
        password: 'correct horse battery staple',
        display_name: 'Owner',
        workspace: { slug: 'personal', name: 'Personal' },
        accepted_terms_version: TERMS_VERSION,
      })
    ).statusCode,
  ).toBe(200);
  expect((await admin.post('/v1/admin/taxonomy.create', { name: 'Runbooks' })).statusCode).toBe(
    200,
  );
}, 180_000);

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('searching knowledge', () => {
  it('finds an item by its words, best first, with the passage it matched', async () => {
    const wanted = await create({
      title: 'Database backup schedule',
      body: 'The PostgreSQL database is dumped nightly at 03:00 and every dump is kept for thirty days.',
      type: 'fact',
      categories: ['runbooks'],
    });
    await create({
      title: 'Office coffee',
      body: 'The machine on the second floor takes beans, not pods.',
      type: 'fact',
    });

    const res = await search({ query: 'database backup' });
    expect(res.statusCode, res.body).toBe(200);
    const { results } = KnowledgeSearchResponse.parse(res.json());
    expect(results[0]?.item_id).toBe(wanted.id);
    // Rule 8: a candidate carries what it takes to fetch the canonical item
    // and see whether it has moved on.
    expect(results[0]?.revision_id).toBe(wanted.current_revision_id);
    expect(results[0]?.content_hash).toBe(wanted.content_hash);
    expect(results[0]?.category_paths).toEqual(['runbooks']);
    // The best hit of a search scores 1; the rest are relative to it.
    expect(results[0]?.score).toBe(1);
    expect(results[0]?.snippet).toContain('<b>');
    expect(results.map((r) => r.title)).not.toContain('Office coffee');
  });

  it('puts a title match above a body that merely mentions the words', async () => {
    await create({
      title: 'Incident escalation',
      body: 'Page the on-call engineer, then the duty manager.',
      type: 'procedure',
    });
    await create({
      title: 'Onboarding notes',
      body: 'Read the incident escalation page before your first on-call shift, and the runbooks after it.',
      type: 'document',
    });

    const { results } = KnowledgeSearchResponse.parse(
      (await search({ query: 'incident escalation' })).json(),
    );
    expect(results[0]?.title).toBe('Incident escalation');
    expect(results[0]?.score_components.title).toBeGreaterThan(0);
  });

  it('stems in the language the item was written in', async () => {
    await create({
      title: 'Резервное копирование',
      body: 'База данных выгружается каждую ночь и хранится тридцать дней.',
      type: 'fact',
      language: 'ru',
    });
    // "копированию" is the same word in another case; a Russian configuration
    // stems them together and `simple` would not.
    const { results } = KnowledgeSearchResponse.parse(
      (await search({ query: 'копированию базы', languages: ['ru'] })).json(),
    );
    expect(results.map((r) => r.title)).toContain('Резервное копирование');
  });

  it('finds an item written in a language the query was not parsed in', async () => {
    await create({
      title: 'Политика паролей',
      body: 'Минимальная длина пароля — двенадцать символов.',
      type: 'instruction',
      language: 'ru',
    });
    // The workspace is English, so the query is parsed as English and the
    // item is stemmed as Russian: the two stemmers never meet. The exact word
    // does, through the unstemmed vector, which is the whole point of it.
    const { results } = KnowledgeSearchResponse.parse((await search({ query: 'пароля' })).json());
    expect(results.map((r) => r.title)).toContain('Политика паролей');
  });

  it('narrows to a category subtree, and to the type', async () => {
    const inRunbooks = await create({
      title: 'Restoring from a dump',
      body: 'Stop the application, restore the dump, run the migrations.',
      type: 'procedure',
      categories: ['runbooks'],
    });
    await create({
      title: 'Restoring morale',
      body: 'Buy the team lunch after a long restore.',
      type: 'fact',
    });

    const scoped = KnowledgeSearchResponse.parse(
      (await search({ query: 'restore', category_paths: ['runbooks'] })).json(),
    );
    expect(scoped.results.map((r) => r.item_id)).toEqual([inRunbooks.id]);

    const typed = KnowledgeSearchResponse.parse(
      (await search({ query: 'restore', types: ['procedure'] })).json(),
    );
    expect(typed.results.every((r) => r.type === 'procedure')).toBe(true);
  });

  it('follows an item through its changes and out of the index when deleted', async () => {
    const item = await create({
      title: 'Deployment target',
      body: 'We deploy to Heroku every Thursday afternoon.',
      type: 'fact',
    });
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'Heroku' })).json()).results,
    ).toHaveLength(1);

    const updated = (
      await admin.post('/v1/admin/knowledge.update', {
        item_id: item.id,
        base_revision_id: item.current_revision_id,
        base_content_hash: item.content_hash,
        body: 'We deploy to Fly.io every Thursday afternoon.',
      })
    ).json() as { item: { current_revision_id: string; content_hash: string } };
    // The index follows the revision: the old words are gone, the new ones
    // are there, and the hit names the revision it was found at.
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'Heroku' })).json()).results,
    ).toHaveLength(0);
    const found = KnowledgeSearchResponse.parse((await search({ query: 'Fly.io' })).json());
    expect(found.results[0]?.revision_id).toBe(updated.item.current_revision_id);

    expect(
      (
        await admin.post('/v1/admin/knowledge.delete', {
          item_id: item.id,
          base_revision_id: updated.item.current_revision_id,
          base_content_hash: updated.item.content_hash,
        })
      ).statusCode,
    ).toBe(200);
    // An item nobody can read should not be findable; the history keeps it.
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'Fly.io' })).json()).results,
    ).toHaveLength(0);

    expect((await admin.post('/v1/admin/knowledge.restore', { item_id: item.id })).statusCode).toBe(
      200,
    );
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'Fly.io' })).json()).results,
    ).toHaveLength(1);
  });

  it('answers nothing to a query that matches nothing', async () => {
    const { results } = KnowledgeSearchResponse.parse(
      (await search({ query: 'wombat telemetry' })).json(),
    );
    expect(results).toEqual([]);
  });
});

/**
 * The index is chunked (ADR 0020), which is what a long document needs.
 */
describe('a long document', () => {
  const filler = (word: string, times: number) =>
    Array.from({ length: times }, () => word).join(' ');

  it('answers from its strongest passage, not from the first one that matched', async () => {
    // Two chunks mention the query. The weak one names a single word among
    // filler; the strong one is the sentence somebody was looking for. Which
    // of the two represents the item is the whole question chunking raises,
    // and the answer has to be the strong one — otherwise a long document
    // answers every query with whichever paragraph happens to come first.
    // Both chunks contain both words — a query ANDs its terms, so a chunk
    // missing one would not match at all and the fold would never be asked.
    // What separates them is proximity, which is what `ts_rank_cd` measures.
    const weak = [filler('routine', 70), 'ledger', filler('routine', 70), 'escalation'].join(' ');
    const strong = 'The ledger escalation path runs through the operator on duty.';
    const long = await create({
      title: 'Operations handbook',
      body: [weak, filler('unrelated', 200), strong, filler('afterwards', 200)].join('\n\n'),
      type: 'document',
      categories: ['runbooks'],
    });

    const { results } = KnowledgeSearchResponse.parse(
      (await search({ query: 'ledger escalation' })).json(),
    );
    expect(results[0]?.item_id).toBe(long.id);
    // The passage is the one that answers, not the other one that also
    // contained the words.
    expect(results[0]?.snippet).toContain('operator');
    expect(results[0]?.snippet).not.toContain('routine');
    // And it says which passage, so a reader can be taken to it.
    expect(results[0]?.chunk_ordinal).toBeGreaterThan(0);
  });

  it('does not win a query by having more words to contain it', async () => {
    // An item is as good as its best chunk. Scoring by the sum would hand
    // every query to the longest document in the workspace.
    const precise = await create({
      title: 'Ledger key rotation',
      body: 'Rotating the ledger key re-signs nothing; the chain is verified with the key of its time.',
      type: 'decision',
      categories: ['runbooks'],
    });
    await create({
      title: 'Everything about everything',
      body: Array.from({ length: 12 }, () => 'The ledger key is mentioned here again.').join(
        '\n\n',
      ),
      type: 'document',
      categories: ['runbooks'],
    });

    const { results } = KnowledgeSearchResponse.parse(
      (await search({ query: 'ledger key rotation' })).json(),
    );
    expect(results[0]?.item_id).toBe(precise.id);
  });

  it('stops being findable by text an edit removed', async () => {
    const item = await create({
      title: 'Shrinking item',
      body: ['The first paragraph stays.', 'Removable sentence about marmalade.'].join('\n\n'),
      type: 'fact',
    });
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'marmalade' })).json()).results,
    ).toHaveLength(1);

    const updated = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'The first paragraph stays.\n',
    });
    expect(updated.statusCode, updated.body).toBe(200);

    // The item has fewer chunks than before. Overwriting the ones it still
    // has would leave the tail of the old text findable.
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'marmalade' })).json()).results,
    ).toEqual([]);
  });
});

describe('an index that was not there when the knowledge was written', () => {
  it('is filled for what it does not hold, without touching what it does', async () => {
    const item = await create({
      title: 'Written before the index',
      body: 'Nothing indexed this at the time.',
      type: 'fact',
    });
    // The state an upgrade leaves behind: the item exists and the projection
    // does not. Search answers nothing, and nothing says why.
    await services.uow.run((tx) => services.repositories.search.remove(tx, item.id as never));
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'indexed this' })).json()).results,
    ).toHaveLength(0);

    const before = await services.repositories.search.countFor(
      (await services.repositories.workspaces.findBySlug('personal'))!.id,
    );
    const result = await services.knowledge.reindex(
      (await services.repositories.workspaces.findBySlug('personal'))!.id,
      { onlyMissing: true },
    );
    // Only the gap, not the whole workspace.
    expect(result.indexed).toBe(1);
    expect(
      await services.repositories.search.countFor(
        (await services.repositories.workspaces.findBySlug('personal'))!.id,
      ),
    ).toBe(before + 1);
    expect(
      KnowledgeSearchResponse.parse((await search({ query: 'indexed this' })).json()).results,
    ).toHaveLength(1);
  });
});
