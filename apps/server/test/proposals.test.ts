import { execFileSync } from 'node:child_process';
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

describe('reviewing a proposal', () => {
  /** A pending proposal from an agent nobody has looked at yet. */
  async function pending(name: string, payload?: Record<string, unknown>) {
    const token = await agentToken('propose', name);
    const res = await asAgent(token, {
      title: `Proposed by ${name}`,
      body: 'Something the agent learned.',
      type: 'fact',
      ...payload,
    });
    expect(res.statusCode, res.body).toBe(202);
    return { token, proposal: ProposalResult.parse(res.json()).proposal };
  }

  it('approves, writes the item, and records who decided', async () => {
    const { proposal } = await pending('Approved proposer');
    const res = await admin.post('/v1/proposal_approve', {
      proposal_id: proposal.id,
      note: 'Checked against the source.',
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = ProposalResult.parse(res.json());
    expect(result.proposal.status).toBe('approved');
    expect(result.proposal.resolution_note).toBe('Checked against the source.');
    expect(result.proposal.result_revision_ids).toHaveLength(1);
    expect(result.item_id).not.toBeNull();
    // The reviewer decided, not the proposer.
    expect(result.proposal.resolved_by_actor_id).not.toBe(proposal.proposed_by_actor_id);

    const item = (await admin.get(`/v1/knowledge.get?item_id=${result.item_id}`)).json() as {
      item: { title: string; review_state: string };
    };
    expect(item.item.title).toBe('Proposed by Approved proposer');
    // A person approved it, so the revision says a person reviewed it.
    expect(item.item.review_state).toBe('human_reviewed');
  });

  it('records the proposal on the commit that applied it', async () => {
    const { proposal } = await pending('Trailer proposer');
    const approved = ProposalResult.parse(
      (await admin.post('/v1/proposal_approve', { proposal_id: proposal.id })).json(),
    );
    const revisions = (
      await admin.get(`/v1/knowledge.revisions?item_id=${approved.item_id}`)
    ).json() as { revisions: { git_commit: string }[] };
    const commit = revisions.revisions[0]!.git_commit;
    const workspace = await services.repositories.workspaces.findBySlug('personal');
    const message = execFileSync(
      'git',
      ['-C', join(dataDir, 'repositories', workspace!.id), 'show', '-s', '--format=%B', commit],
      { encoding: 'utf8' },
    );
    // The repository alone leads back to the decision that produced the file.
    expect(message).toContain(`Knoverge-Proposal: ${proposal.id}`);
  });

  it('keeps the reviewer’s text when approving with edits', async () => {
    const { proposal } = await pending('Edited proposer');
    const res = await admin.post('/v1/proposal_approve', {
      proposal_id: proposal.id,
      edits: { title: 'What the reviewer wrote', tags: ['reviewed'] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = ProposalResult.parse(res.json());
    // A different status, because the item is not what the proposer wrote.
    expect(result.proposal.status).toBe('approved_with_edits');

    const item = (await admin.get(`/v1/knowledge.get?item_id=${result.item_id}`)).json() as {
      item: { title: string; tags: string[]; body: string };
    };
    expect(item.item.title).toBe('What the reviewer wrote');
    expect(item.item.tags).toEqual(['reviewed']);
    // Untouched fields keep what was proposed. The trailing newline is the
    // file's, which is what a body read back from Git carries.
    expect(item.item.body).toContain('Something the agent learned.');

    const detail = (await admin.get(`/v1/proposal.get?proposal_id=${proposal.id}`)).json() as {
      proposal: { proposed_payload: { title: string } };
    };
    // The payload is what was approved: the trail must not claim the proposer
    // wrote text they never saw.
    expect(detail.proposal.proposed_payload.title).toBe('What the reviewer wrote');
  });

  it('refuses to approve twice', async () => {
    const { proposal } = await pending('Twice proposer');
    expect(
      (await admin.post('/v1/proposal_approve', { proposal_id: proposal.id })).statusCode,
    ).toBe(200);
    const again = await admin.post('/v1/proposal_approve', { proposal_id: proposal.id });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().code).toBe('PROPOSAL_ALREADY_RESOLVED');
  });

  it('replays a retried approval instead of writing a second item', async () => {
    const { proposal } = await pending('Retried approval');
    const key = { 'idempotency-key': 'approve-key-0001' };
    const first = await admin.request({
      method: 'POST',
      url: '/v1/proposal_approve',
      headers: key,
      payload: { proposal_id: proposal.id },
    });
    const second = await admin.request({
      method: 'POST',
      url: '/v1/proposal_approve',
      headers: key,
      payload: { proposal_id: proposal.id },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(ProposalResult.parse(second.json()).item_id).toBe(
      ProposalResult.parse(first.json()).item_id,
    );
  });

  it('rejects with a reason, and writes nothing', async () => {
    const { proposal } = await pending('Rejected proposer');
    const before = (await admin.get('/v1/knowledge.list')).json() as { items: unknown[] };
    const res = await admin.post('/v1/proposal_reject', {
      proposal_id: proposal.id,
      reason: 'Already recorded elsewhere.',
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = ProposalResult.parse(res.json());
    expect(result.proposal.status).toBe('rejected');
    expect(result.proposal.resolution_note).toBe('Already recorded elsewhere.');
    expect(result.item_id).toBeNull();
    const after = (await admin.get('/v1/knowledge.list')).json() as { items: unknown[] };
    // A rejection writes nothing at all, not even a deleted item.
    expect(after.items).toHaveLength(before.items.length);
  });

  it('lets the proposer withdraw, and refuses somebody else', async () => {
    const { token, proposal } = await pending('Withdrawing proposer');
    const other = await agentToken('propose', 'Meddling agent');
    const meddle = await app.inject({
      method: 'POST',
      url: '/v1/proposal_withdraw',
      headers: { authorization: `Bearer ${other}` },
      payload: { proposal_id: proposal.id },
    });
    // Withdrawing somebody else's proposal is a reviewer's act.
    expect(meddle.statusCode, meddle.body).toBe(403);

    const mine = await app.inject({
      method: 'POST',
      url: '/v1/proposal_withdraw',
      headers: { authorization: `Bearer ${token}` },
      payload: { proposal_id: proposal.id, reason: 'No longer relevant.' },
    });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(ProposalResult.parse(mine.json()).proposal.status).toBe('withdrawn');
  });

  it('refuses an actor approving its own proposal', async () => {
    // The owner writes a proposal the only way a person can: by being granted
    // the agent's actor is impossible, so this uses an agent that also holds
    // knowledge.approve — the same actor on both sides of the decision.
    const token = await agentToken('propose', 'Self approver');
    const agents = (await admin.get('/v1/admin/agents.list')).json() as {
      agents: { actor_id: string; name: string }[];
    };
    const actorId = agents.agents.find((a) => a.name === 'Self approver')!.actor_id;
    expect(
      (
        await admin.post('/v1/admin/permissions.grant', {
          actor_id: actorId,
          action: 'knowledge.approve',
        })
      ).statusCode,
    ).toBe(200);
    const created = ProposalResult.parse(
      (await asAgent(token, { title: 'Mine to approve', body: 'Body.', type: 'fact' })).json(),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposal_approve',
      headers: { authorization: `Bearer ${token}` },
      payload: { proposal_id: created.proposal.id },
    });
    // Review is a second pair of eyes or it is nothing.
    expect(res.statusCode, res.body).toBe(403);
  });

  it('marks a revision agent_reviewed when an agent approves', async () => {
    const { proposal } = await pending('Agent reviewed');
    const reviewer = await agentToken('propose', 'Curator agent');
    const agents = (await admin.get('/v1/admin/agents.list')).json() as {
      agents: { actor_id: string; name: string }[];
    };
    const actorId = agents.agents.find((a) => a.name === 'Curator agent')!.actor_id;
    expect(
      (
        await admin.post('/v1/admin/permissions.grant', {
          actor_id: actorId,
          action: 'knowledge.approve',
        })
      ).statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposal_approve',
      headers: { authorization: `Bearer ${reviewer}` },
      payload: { proposal_id: proposal.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = ProposalResult.parse(res.json());
    const item = (await admin.get(`/v1/knowledge.get?item_id=${result.item_id}`)).json() as {
      item: { review_state: string };
    };
    // An agent reviewed it, which is not the same as a person having done so.
    expect(item.item.review_state).toBe('agent_reviewed');
  });
});

describe('proposing a change to an item that exists', () => {
  /** An item a person wrote, and what a proposer would have read of it. */
  async function anItem(title: string) {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body: 'The text as it stands.',
      type: 'fact',
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = (res.json() as { item: { id: string } }).item;
    return item as { id: string; current_revision_id: string; content_hash: string };
  }

  const proposeUpdate = (token: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/knowledge_propose_update',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  const proposeDelete = (token: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/knowledge_propose_delete',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  it('records an update for review and applies it on approval', async () => {
    const token = await agentToken('propose', 'Updating agent');
    const item = await anItem('Item to update');
    const res = await proposeUpdate(token, {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'The text the agent would rather have.',
      reason: 'The source changed.',
    });
    expect(res.statusCode, res.body).toBe(202);
    const proposed = ProposalResult.parse(res.json());
    expect(proposed.proposal.proposal_type).toBe('knowledge_update');
    expect(proposed.proposal.target_item_id).toBe(item.id);
    expect(proposed.proposal.base_revision_id).toBe(item.current_revision_id);

    // Nothing changed yet: a pending proposal is not a write.
    const before = (await admin.get(`/v1/knowledge.get?item_id=${item.id}`)).json() as {
      item: { body: string };
    };
    expect(before.item.body).toContain('The text as it stands.');

    const approved = await admin.post('/v1/proposal_approve', {
      proposal_id: proposed.proposal.id,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const after = (await admin.get(`/v1/knowledge.get?item_id=${item.id}`)).json() as {
      item: { body: string; revision_number: number; review_state: string };
    };
    expect(after.item.body).toContain('The text the agent would rather have.');
    expect(after.item.revision_number).toBe(2);
    expect(after.item.review_state).toBe('human_reviewed');
  });

  it('refuses a proposal written against an older revision', async () => {
    const token = await agentToken('propose', 'Stale proposer');
    const item = await anItem('Item that moves on');
    // The person edits it after the agent read it.
    const moved = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'Changed by a person first.',
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const res = await proposeUpdate(token, {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'Written against what the agent read.',
    });
    // Told now, rather than after a reviewer has spent attention on it.
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('REVISION_CONFLICT');
  });

  it('puts the second proposal for one item into conflict when the first is approved', async () => {
    const first = await agentToken('propose', 'First proposer');
    const second = await agentToken('propose', 'Second proposer');
    const item = await anItem('Item two agents want');
    const base = {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
    };
    const one = ProposalResult.parse(
      (await proposeUpdate(first, { ...base, body: 'What the first agent wants.' })).json(),
    );
    const two = ProposalResult.parse(
      (await proposeUpdate(second, { ...base, body: 'What the second agent wants.' })).json(),
    );

    expect(
      (await admin.post('/v1/proposal_approve', { proposal_id: one.proposal.id })).statusCode,
    ).toBe(200);

    const other = (await admin.get(`/v1/proposal.get?proposal_id=${two.proposal.id}`)).json() as {
      proposal: { status: string; resolution_note: string };
    };
    // Not rejected: nobody decided against it, and the difference matters to
    // whoever proposed it.
    expect(other.proposal.status).toBe('conflict');
    expect(other.proposal.resolution_note).toMatch(/changed while this proposal was waiting/);
  });

  it('puts a proposal into conflict when a direct write overtakes it', async () => {
    const token = await agentToken('propose', 'Overtaken proposer');
    const item = await anItem('Item overtaken by a person');
    const proposed = ProposalResult.parse(
      (
        await proposeUpdate(token, {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
          body: 'What the agent proposed.',
        })
      ).json(),
    );
    const moved = await admin.post('/v1/admin/knowledge.update', {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      body: 'What the person wrote instead.',
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const approved = await admin.post('/v1/proposal_approve', {
      proposal_id: proposed.proposal.id,
    });
    expect(approved.statusCode, approved.body).toBe(409);
    const after = (
      await admin.get(`/v1/proposal.get?proposal_id=${proposed.proposal.id}`)
    ).json() as { proposal: { status: string } };
    // It must not go back into the inbox to fail the same way for the next
    // reviewer.
    expect(after.proposal.status).toBe('conflict');
  });

  it('records a delete for review and applies it on approval', async () => {
    const token = await agentToken('propose', 'Deleting agent');
    const item = await anItem('Item to delete');
    const res = await proposeDelete(token, {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      reason: 'Superseded by the handbook.',
    });
    expect(res.statusCode, res.body).toBe(202);
    const proposed = ProposalResult.parse(res.json());
    expect(proposed.proposal.proposal_type).toBe('knowledge_delete');

    const approved = await admin.post('/v1/proposal_approve', {
      proposal_id: proposed.proposal.id,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const listed = (await admin.get('/v1/knowledge.list')).json() as {
      items: { id: string; status: string }[];
    };
    // Logical: the file leaves the tree and the history keeps it.
    expect(listed.items.find((i) => i.id === item.id)?.status).toBe('deleted');
  });

  it('refuses to edit a delete proposal, which carries nothing to edit', async () => {
    const token = await agentToken('propose', 'Delete editor');
    const item = await anItem('Item somebody wants edited away');
    const proposed = ProposalResult.parse(
      (
        await proposeDelete(token, {
          item_id: item.id,
          base_revision_id: item.current_revision_id,
          base_content_hash: item.content_hash,
        })
      ).json(),
    );
    const res = await admin.post('/v1/proposal_approve', {
      proposal_id: proposed.proposal.id,
      edits: { title: 'Something else entirely' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('writes straight away when a rule allows the update directly', async () => {
    const token = await agentToken('trusted', 'Direct updater');
    const agents = (await admin.get('/v1/admin/agents.list')).json() as {
      agents: { actor_id: string; name: string }[];
    };
    const actorId = agents.agents.find((a) => a.name === 'Direct updater')!.actor_id;
    expect(
      (
        await admin.post('/v1/admin/policy.rules.upsert', {
          priority: 10,
          subject: { actor_id: actorId },
          action: 'knowledge.update',
          effect: 'allow_direct',
        })
      ).statusCode,
    ).toBe(200);
    const item = await anItem('Item an agent may change');
    const res = await proposeUpdate(token, {
      item_id: item.id,
      base_revision_id: item.current_revision_id,
      base_content_hash: item.content_hash,
      title: 'Changed by a trusted agent',
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = ProposalResult.parse(res.json());
    expect(result.proposal.status).toBe('approved');
    expect(result.proposal.policy_decision).toBe('allow_direct');
    expect(result.item_id).toBe(item.id);
  });
});
