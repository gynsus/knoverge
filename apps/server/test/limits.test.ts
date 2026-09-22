import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { AGENT_LIMITS, MAX_TOOL_BODY_BYTES } from '../src/plugins/agent-limits.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let admin: Browser;
let token: string;

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

const asAgent = (url: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });

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
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'f6'.repeat(32), cookieSecure: false },
    // The real budgets, so the test measures what a deployment does.
    rateLimit: {},
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
  const created = await admin.post('/v1/admin/agents.create', {
    name: 'Busy agent',
    trust_tier: 'propose',
  });
  const agentId = (created.json() as { agent: { id: string } }).agent.id;
  token = (
    (
      await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agentId })
    ).json() as { token: string }
  ).token;
}, 180_000);

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('what an agent may ask for', () => {
  it('gives a write a smaller budget than a read', () => {
    // The plan asks for separate buckets. A write takes the workspace lock,
    // makes a commit and appends to the ledger; a read does none of those.
    expect(AGENT_LIMITS.write.max).toBeLessThan(AGENT_LIMITS.read.max);
  });

  it('refuses a body larger than a tool call may carry', async () => {
    const res = await asAgent('/v1/knowledge_propose_create', {
      title: 'Far too much',
      body: 'x'.repeat(MAX_TOOL_BODY_BYTES + 1024),
      type: 'document',
    });
    // Refused as the caller's mistake, not logged as the server's.
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('answers RATE_LIMITED rather than failing, once the budget is gone', async () => {
    let limited = 0;
    let answered = 0;
    for (let i = 0; i < AGENT_LIMITS.write.max + 5; i += 1) {
      const res = await asAgent('/v1/knowledge_propose_create', {
        title: `Proposal number ${i}`,
        body: `One of many proposals, number ${i}.`,
        type: 'fact',
      });
      if (res.statusCode === 429) {
        limited += 1;
        // A caller told to slow down is told for how long.
        expect(res.headers['retry-after']).toBeDefined();
        expect(res.json().code).toBe('RATE_LIMITED');
        expect(res.json().retryable).toBe(true);
      } else {
        answered += 1;
      }
    }
    expect(limited).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(AGENT_LIMITS.write.max);
  });

  it('leaves a read budget when the write budget is gone', async () => {
    // Separate buckets, which is the point of having two: an agent that has
    // used up its writes can still read what it needs to decide what to do.
    const res = await asAgent('/v1/knowledge_index', { limit: 1 });
    expect(res.statusCode, res.body).toBe(200);
  });
});
