import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ProposalResult, ProposalsResponse } from '@knoverge/contracts';
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

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    // Each suite writes its workspace repositories to a directory of its own.
    dataDir: dataDir,
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
  const res = await admin.post('/v1/bootstrap', {
    ...OWNER,
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

/** An agent with the tier this test needs, and a browser that speaks as it. */
async function agentToken(tier: string, name: string): Promise<string> {
  const created = await admin.post('/v1/admin/agents.create', { name, trust_tier: tier });
  expect(created.statusCode, created.body).toBe(200);
  const agentId = (created.json() as { agent: { id: string } }).agent.id;
  const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agentId });
  expect(issued.statusCode, issued.body).toBe(200);
  return (issued.json() as { token: string }).token;
}

const asAgent = (token: string, payload: unknown, idempotencyKey?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/knowledge_propose_create',
    headers: {
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    payload: payload as Record<string, unknown>,
  });

const agentGet = (token: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('an agent proposing', () => {
  it('records a proposal for review rather than writing (rule 14)', async () => {
    // A trusted agent holds knowledge.write, and it still waits: without an
    // explicit allow_direct rule every agent write requires review.
    const token = await agentToken('trusted', 'Proposer');
    const res = await asAgent(token, {
      title: 'Proposed by an agent',
      body: 'Something the agent learned.',
      type: 'fact',
      reason: 'Seen in three places.',
      confidence: 0.8,
    });
    expect(res.statusCode, res.body).toBe(202);
    const result = ProposalResult.parse(res.json());
    expect(result.proposal.status).toBe('pending');
    expect(result.proposal.policy_decision).toBe('require_review');
    // Nothing was written: the item does not exist yet.
    expect(result.item_id).toBeNull();

    const inbox = ProposalsResponse.parse(
      (await admin.get('/v1/proposal.list?status=pending')).json(),
    );
    expect(inbox.proposals.map((p) => p.id)).toContain(result.proposal.id);
    expect(inbox.proposals.find((p) => p.id === result.proposal.id)).toMatchObject({
      reason: 'Seen in three places.',
      confidence: 0.8,
    });
  });

  it('writes straight away when a rule allows it, and still records why', async () => {
    const token = await agentToken('trusted', 'Direct writer');
    const agents = (await admin.get('/v1/admin/agents.list')).json() as {
      agents: { id: string; actor_id: string; name: string }[];
    };
    const actorId = agents.agents.find((a) => a.name === 'Direct writer')!.actor_id;
    const rule = await admin.post('/v1/admin/policy.rules.upsert', {
      priority: 10,
      subject: { actor_id: actorId },
      action: 'knowledge.create',
      effect: 'allow_direct',
    });
    expect(rule.statusCode, rule.body).toBe(200);

    const res = await asAgent(token, {
      title: 'Written by an agent',
      body: 'Allowed directly by a rule.',
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = ProposalResult.parse(res.json());
    // Applied, and recorded anyway: the trail reads the same whether a person
    // said yes or a rule did, and who resolved it says which.
    expect(result.item_id).not.toBeNull();
    expect(result.proposal.status).toBe('approved');
    expect(result.proposal.policy_decision).toBe('allow_direct');
    expect(result.proposal.result_revision_ids).toHaveLength(1);
    expect(result.proposal.resolved_by_actor_id).not.toBe(actorId);

    const detail = (
      await admin.get(`/v1/proposal.get?proposal_id=${result.proposal.id}`)
    ).json() as { proposal: { proposed_payload: { title: string } } };
    expect(detail.proposal.proposed_payload.title).toBe('Written by an agent');
  });

  it('refuses without a proposal when policy denies', async () => {
    const token = await agentToken('trusted', 'Denied writer');
    const agents = (await admin.get('/v1/admin/agents.list')).json() as {
      agents: { actor_id: string; name: string }[];
    };
    const actorId = agents.agents.find((a) => a.name === 'Denied writer')!.actor_id;
    expect(
      (
        await admin.post('/v1/admin/policy.rules.upsert', {
          priority: 5,
          subject: { actor_id: actorId },
          action: 'knowledge.create',
          effect: 'deny',
        })
      ).statusCode,
    ).toBe(200);

    const before = ProposalsResponse.parse((await admin.get('/v1/proposal.list')).json());
    const res = await asAgent(token, { title: 'Refused', body: 'Body.', type: 'fact' });
    expect(res.statusCode, res.body).toBe(403);
    // A denial is not a proposal: there was nothing for anybody to review.
    const after = ProposalsResponse.parse((await admin.get('/v1/proposal.list')).json());
    expect(after.proposals).toHaveLength(before.proposals.length);
  });

  it('refuses an agent that may not propose at all', async () => {
    const token = await agentToken('read_only', 'Reader');
    const res = await asAgent(token, { title: 'Not allowed', body: 'Body.', type: 'fact' });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toMatch(/knowledge.propose_create/);
  });

  it('replays a retried proposal instead of recording a second one', async () => {
    const token = await agentToken('propose', 'Retrying proposer');
    const payload = { title: 'Retried', body: 'Sent twice.', type: 'fact' };
    const first = await asAgent(token, payload, 'retry-key-0001');
    expect(first.statusCode, first.body).toBe(202);
    const second = await asAgent(token, payload, 'retry-key-0001');
    expect(second.statusCode, second.body).toBe(202);
    const one = ProposalResult.parse(first.json());
    const two = ProposalResult.parse(second.json());
    expect(two.proposal.id).toBe(one.proposal.id);

    const inbox = ProposalsResponse.parse((await agentGet(token, '/v1/proposal.list')).json());
    expect(inbox.proposals.filter((p) => p.id === one.proposal.id)).toHaveLength(1);
  });

  it('refuses a proposal whose relation points at nothing', async () => {
    const token = await agentToken('propose', 'Dangling proposer');
    const res = await asAgent(token, {
      title: 'Dangling',
      body: 'Points at an item that does not exist.',
      type: 'fact',
      relations: [{ type: 'supersedes', target: 'kn_01J8Z2A0C1D2E3F4G5H6J7K8M9' }],
    });
    // Checked before the proposal is recorded: a reviewer must not be handed
    // something that can only fail on approval.
    expect(res.statusCode, res.body).toBe(404);
  });

  it('empties the text of a resolved proposal and keeps the row', async () => {
    const token = await agentToken('trusted', 'Aged writer');
    const agents = (await admin.get('/v1/admin/agents.list')).json() as {
      agents: { actor_id: string; name: string }[];
    };
    const actorId = agents.agents.find((a) => a.name === 'Aged writer')!.actor_id;
    expect(
      (
        await admin.post('/v1/admin/policy.rules.upsert', {
          priority: 10,
          subject: { actor_id: actorId },
          action: 'knowledge.create',
          effect: 'allow_direct',
        })
      ).statusCode,
    ).toBe(200);
    const resolved = ProposalResult.parse(
      (await asAgent(token, { title: 'Aged', body: 'Resolved long ago.', type: 'fact' })).json(),
    );
    const pending = ProposalResult.parse(
      (
        await asAgent(await agentToken('propose', 'Still waiting'), {
          title: 'Waiting',
          body: 'Nobody has decided.',
          type: 'fact',
        })
      ).json(),
    );

    // A cutoff in the future, so every already-resolved proposal is old enough.
    const emptied = await services.uow.run((tx) =>
      services.repositories.proposals.redactResolvedBefore(tx, new Date(Date.now() + 60_000)),
    );
    expect(emptied).toBeGreaterThanOrEqual(1);

    const after = (
      await admin.get(`/v1/proposal.get?proposal_id=${resolved.proposal.id}`)
    ).json() as { proposal: { proposed_payload: Record<string, unknown>; status: string } };
    expect(after.proposal.proposed_payload).toEqual({});
    // The row and the decision survive; only the text is gone.
    expect(after.proposal.status).toBe('approved');

    // A pending proposal is still waiting for somebody, so its text stays.
    const untouched = (
      await admin.get(`/v1/proposal.get?proposal_id=${pending.proposal.id}`)
    ).json() as { proposal: { proposed_payload: { title?: string } } };
    expect(untouched.proposal.proposed_payload.title).toBe('Waiting');
  });

  it("shows an agent its own proposals and not another agent's", async () => {
    const mine = await agentToken('propose', 'Own reader');
    const other = await agentToken('propose', 'Other proposer');
    const created = ProposalResult.parse(
      (await asAgent(mine, { title: 'Mine', body: 'Body.', type: 'fact' })).json(),
    );
    const theirs = ProposalResult.parse(
      (await asAgent(other, { title: 'Theirs', body: 'Body.', type: 'fact' })).json(),
    );

    const listed = ProposalsResponse.parse((await agentGet(mine, '/v1/proposal.list')).json());
    expect(listed.proposals.map((p) => p.id)).toEqual([created.proposal.id]);
    expect(
      (await agentGet(mine, `/v1/proposal.get?proposal_id=${created.proposal.id}`)).statusCode,
    ).toBe(200);
    // Not 403: whether somebody else's proposal exists is not this agent's to
    // learn from the answer.
    expect(
      (await agentGet(mine, `/v1/proposal.get?proposal_id=${theirs.proposal.id}`)).statusCode,
    ).toBe(404);
  });
});
