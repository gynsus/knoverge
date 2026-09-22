import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KnowledgeSearchResponse } from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
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
