import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ProposalResult, TERMS_VERSION, WorkspaceManifest } from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { DEFAULT_AGENT_LIMITS } from '../src/plugins/agent-limits.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

/**
 * Three, so the test can reach the wall without a hundred writes.
 *
 * The default is two hundred: high enough for a reconciliation pass to land, low
 * enough that a loop is stopped within a minute.
 */
const CAP = 3;

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let admin: Browser;
let token: string;
let actorId: string;

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

/** Text of its own each time, or the duplicate check answers before the cap does. */
const propose = (n: number) =>
  app.inject({
    method: 'POST',
    url: '/v1/knowledge_propose_create',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: `Finding number ${n} about the deployment of service ${n}`,
      body: `What the agent learned while looking at service ${n}, in its own words.\n`,
      type: 'fact',
    },
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-backlog-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('d4'.repeat(32)),
    tokenPepper: 'e5'.repeat(32),
    poolMax: 4,
    pendingPerActor: CAP,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'f6'.repeat(32), cookieSecure: false },
    // Whatever the rate limits are, they are not what this file is about.
    agentBudgets: {
      ...DEFAULT_AGENT_LIMITS,
      readsPerMinute: 100_000,
      writesPerMinute: 100_000,
      pendingProposals: CAP,
    },
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

  const created = await admin.post('/v1/admin/agents.create', {
    name: 'Eager proposer',
    trust_tier: 'propose',
  });
  expect(created.statusCode, created.body).toBe(200);
  const agent = (created.json() as { agent: { id: string; actor_id: string } }).agent;
  actorId = agent.actor_id;
  const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id });
  token = (issued.json() as { token: string }).token;
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await app?.close();
  await services?.close();
  await container?.stop();
});

/**
 * The backlog a rate limit cannot see.
 *
 * Sixty writes a minute for an hour is three thousand pending proposals, every
 * one of them inside every budget the server enforces, and the review queue is
 * where every agent write is decided. Rule 5 makes a proposal the only way an
 * agent writes, so this is the one abuse control the product's own shape asks for.
 */
describe('how much one actor may leave waiting', () => {
  it('says the number, so a client can pace itself', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspace_manifest',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(WorkspaceManifest.parse(res.json()).limits.pending_proposals).toBe(CAP);
  });

  it('takes what it allows, and refuses the one after that', async () => {
    for (let n = 1; n <= CAP; n += 1) {
      const res = await propose(n);
      expect(res.statusCode, res.body).toBe(202);
    }
    const tooMany = await propose(CAP + 1);
    expect(tooMany.statusCode, tooMany.body).toBe(429);
    expect(tooMany.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    // Retryable, and the message says what has to happen rather than "slow down":
    // waiting does not clear this one, a reviewer does.
    expect(tooMany.json().message).toContain('waiting for review');
  });

  it('makes room when a reviewer decides one', async () => {
    const waiting = (await admin.get('/v1/proposal.list?status=pending')).json() as {
      proposals: { id: string }[];
    };
    const first = waiting.proposals[0]!;
    expect((await admin.post('/v1/proposal_reject', { proposal_id: first.id })).statusCode).toBe(
      200,
    );
    // The queue is what the budget is about, so emptying it is what refills the
    // budget. Nothing about time.
    const again = await propose(CAP + 2);
    expect(again.statusCode, again.body).toBe(202);
  });

  it('does not count a write a policy rule lets through', async () => {
    // An allow_direct write is decided and gone; counting it would make a rule
    // that grants more end up granting less.
    const rule = await admin.post('/v1/admin/policy.rules.upsert', {
      priority: 10,
      subject: { actor_id: actorId },
      action: 'knowledge.create',
      effect: 'allow_direct',
    });
    expect(rule.statusCode, rule.body).toBe(200);

    // Written out rather than generated: these become items, and the duplicate
    // check compares items — six variations on one sentence would be refused as
    // near-duplicates of each other before the cap ever came up.
    const written = [
      { title: 'Support closes at five on Fridays', body: 'Brisbane time, all year.\n' },
      { title: 'The staging database is restored weekly', body: 'From the newest backup.\n' },
      { title: 'Deployment needs two approvals', body: 'One of them from outside the team.\n' },
      { title: 'Invoices are raised on the first', body: 'Whatever day of the week it is.\n' },
      { title: 'The office is closed between Christmas and the new year', body: 'Every year.\n' },
      { title: 'Laptops are replaced after four years', body: 'Or sooner if a part fails.\n' },
    ];
    for (const item of written) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/knowledge_propose_create',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...item, type: 'fact' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(ProposalResult.parse(res.json()).item_id).not.toBeNull();
    }
  });
});
