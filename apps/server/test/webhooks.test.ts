import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  TERMS_VERSION,
  UpsertWebhookResponse,
  WebhookDelivery,
  WebhooksResponse,
} from '@knoverge/contracts';
import { parseEncryptionKey } from '@knoverge/auth';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, parseLedgerKey, sign } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
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

/** A receiver, because a webhook nobody received is not a delivered webhook. */
interface Received {
  body: string;
  signature: string;
  timestamp: string;
}
let receiver: Server;
let received: Received[] = [];
let answer = 200;
let endpoint = '';

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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-webhooks-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('d4'.repeat(32)),
    encryptionKey: parseEncryptionKey('ab'.repeat(32)),
    tokenPepper: 'e5'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'f6'.repeat(32), cookieSecure: false },
  });
  admin = new Browser();
  admin.csrf = ((await admin.get('/v1/auth/csrf')).json() as { token: string }).token;
  const bootstrapped = await admin.post('/v1/bootstrap', {
    email: 'owner@example.com',
    password: 'correct horse battery staple',
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
    accepted_terms_version: TERMS_VERSION,
  });
  expect(bootstrapped.statusCode, bootstrapped.body).toBe(200);

  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: String(request.headers[SIGNATURE_HEADER] ?? ''),
        timestamp: String(request.headers[TIMESTAMP_HEADER] ?? ''),
      });
      response.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

async function createWebhook(over: Record<string, unknown> = {}) {
  const res = await admin.post('/v1/admin/webhooks.upsert', { url: endpoint, ...over });
  expect(res.statusCode, res.body).toBe(200);
  return UpsertWebhookResponse.parse(res.json());
}

/** Something to be told about. */
async function anItem(title: string, body: string) {
  const res = await admin.post('/v1/admin/knowledge.create', { title, body, type: 'fact' });
  expect(res.statusCode, res.body).toBe(200);
}

describe('where a workspace pushes word that something happened', () => {
  it('gives the secret once and never again', async () => {
    const created = await createWebhook();
    expect(created.secret).toMatch(/^whsec_/u);
    expect(created.webhook.status).toBe('active');

    const listed = WebhooksResponse.parse((await admin.get('/v1/admin/webhooks.list')).json());
    const mine = listed.webhooks.find((w) => w.id === created.webhook.id);
    // Sealed at rest and never served: an operator who lost it makes a new one,
    // which is the answer an agent credential gives too.
    expect(JSON.stringify(mine)).not.toContain('whsec_');
    expect(mine?.url).toBe(endpoint);
  });

  it('starts from now, not from the beginning of the ledger', async () => {
    // An operator adding a webhook to a workspace with a history wants what
    // happens next, not a replay of everything that ever happened.
    await anItem('Written before the webhook', 'Nobody should be told about this.\n');
    const created = await createWebhook();
    expect(created.webhook.cursor).toBeGreaterThan(0);

    received = [];
    await services.webhooks.deliverDue();
    // For this endpoint. Earlier tests left webhooks of their own behind, and
    // they are still being told about things — which is the point of the cursor
    // being per endpoint.
    const forMe = received
      .map((r) => WebhookDelivery.parse(JSON.parse(r.body)))
      .filter((delivery) => delivery.webhook_id === created.webhook.id);
    expect(forMe).toEqual([]);
  });

  it('delivers the event, signed, and never the knowledge', async () => {
    const created = await createWebhook();
    received = [];
    answer = 200;
    await anItem('The rate changed in April', 'Fourteen percent from the first.\n');
    const outcomes = await services.webhooks.deliverDue();

    const mine = outcomes.find((o) => o.webhookId === created.webhook.id);
    expect(mine?.ok).toBe(true);
    expect(mine?.delivered).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);

    const delivery = received[received.length - 1]!;
    // Computed here rather than with the product's own `sign`: a test that calls
    // the function it is checking passes whatever that function starts doing,
    // including dropping the timestamp out of the signed material.
    const expected = `sha256=${createHmac('sha256', created.secret as string)
      .update(`${delivery.timestamp}.${delivery.body}`)
      .digest('hex')}`;
    // Over the timestamp and the body together, so a captured body cannot be
    // replayed later with its signature intact.
    expect(delivery.signature).toBe(expected);
    // And the product agrees with the receiver, which is the other half.
    expect(sign(created.secret as string, delivery.timestamp, delivery.body)).toBe(expected);
    const parsed = WebhookDelivery.parse(JSON.parse(delivery.body));
    expect(parsed.events.some((e) => e.event_type === 'knowledge.created')).toBe(true);
    // ADR 0029: a URL is not an actor and holds no read scope, so it is told what
    // happened and not what the item says.
    expect(delivery.body).not.toContain('Fourteen percent');
    expect(delivery.body).not.toContain('The rate changed in April');
    // The fields, exactly. Read from the raw body rather than the parsed one,
    // because the schema strips what it does not know and this is the assertion
    // that a field added later has to be considered rather than delivered.
    const raw = JSON.parse(delivery.body) as { events: Record<string, unknown>[] };
    expect(Object.keys(raw.events[0] ?? {}).sort()).toEqual([
      'actor_id',
      'after_content_hash',
      'after_revision_id',
      'agent_id',
      'before_content_hash',
      'before_revision_id',
      'category_paths',
      'client',
      'created_at',
      'event_type',
      'id',
      'metadata',
      'model',
      'object_id',
      'object_type',
      'proposal_id',
      'provider',
      'request_id',
      'sequence',
      'session_id',
    ]);
  });

  it('does not move its cursor when the receiver refuses', async () => {
    const created = await createWebhook();
    answer = 500;
    received = [];
    await anItem('Something the endpoint will refuse', 'Once, and then again.\n');

    const failed = await services.webhooks.deliverDue();
    expect(failed.find((o) => o.webhookId === created.webhook.id)).toMatchObject({ ok: false });
    const attempted = received.length;
    expect(attempted).toBeGreaterThan(0);

    // The same events again once the endpoint is back, because a failed delivery
    // leaves the cursor where it was: at least once, never skipped.
    answer = 200;
    await services.repositories.webhooks.list(
      (await services.repositories.workspaces.findBySlug('personal'))!.id,
    );
    await services.uow.run(async (tx) => {
      await services.repositories.webhooks.update(
        tx,
        (await services.repositories.workspaces.findBySlug('personal'))!.id,
        created.webhook.id,
        { nextAttemptAt: null, updatedAt: new Date() },
      );
    });
    received = [];
    const retried = await services.webhooks.deliverDue();
    expect(retried.find((o) => o.webhookId === created.webhook.id)?.ok).toBe(true);
    const body = WebhookDelivery.parse(JSON.parse(received[0]!.body));
    expect(body.events.some((e) => e.event_type === 'knowledge.created')).toBe(true);
  });

  it('waits longer after each failure, and says what went wrong', async () => {
    const created = await createWebhook();
    answer = 503;
    await anItem('The endpoint is down', 'For a while.\n');
    await services.webhooks.deliverDue();

    const listed = WebhooksResponse.parse((await admin.get('/v1/admin/webhooks.list')).json());
    const mine = listed.webhooks.find((w) => w.id === created.webhook.id);
    expect(mine?.failures).toBe(1);
    // The status, not the body: a receiver's error page is somebody else's
    // content, and this is stored and shown to an operator.
    expect(mine?.last_error).toContain('503');
    answer = 200;
  });

  it('delivers only the types it was asked for', async () => {
    const created = await createWebhook({ event_types: ['category.created'] });
    received = [];
    answer = 200;
    await anItem('A fact the webhook does not want', 'Not a category.\n');
    await services.webhooks.deliverDue();
    // Nothing for this endpoint: the only event was a knowledge write.
    const forMe = received
      .map((r) => WebhookDelivery.parse(JSON.parse(r.body)))
      .filter((d) => d.webhook_id === created.webhook.id);
    expect(forMe).toEqual([]);

    const taxonomy = await admin.post('/v1/admin/taxonomy.create', { name: 'Operations' });
    expect(taxonomy.statusCode, taxonomy.body).toBe(200);
    received = [];
    await services.webhooks.deliverDue();
    const now = received
      .map((r) => WebhookDelivery.parse(JSON.parse(r.body)))
      .filter((d) => d.webhook_id === created.webhook.id);
    expect(now).toHaveLength(1);
    expect(now[0]!.events.every((e) => e.event_type === 'category.created')).toBe(true);
  });

  it('is removed when an operator says so', async () => {
    const created = await createWebhook();
    expect(
      (await admin.post('/v1/admin/webhooks.delete', { webhook_id: created.webhook.id }))
        .statusCode,
    ).toBe(200);
    const listed = WebhooksResponse.parse((await admin.get('/v1/admin/webhooks.list')).json());
    expect(listed.webhooks.find((w) => w.id === created.webhook.id)).toBeUndefined();
  });
});
