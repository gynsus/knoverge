import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  TERMS_VERSION,
  KnowledgeResponse,
  SyncBeginResult,
  SyncCompleteResult,
  SyncMatchesResult,
  ProposalsResponse,
  SyncRunsResponse,
  SyncStatusResult,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { refineSyncSession } from '../src/refine.ts';
import { createServices, type Services } from '../src/services.ts';

/**
 * Reconciliation, the thing the product is for: an agent arrives holding
 * knowledge and finds out what the workspace already has before it writes
 * anything.
 */
const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let admin: Browser;
let agentToken: string;

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
}

/** The agent's own voice: a bearer token, which is how a client speaks. */
function agent(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { authorization: `Bearer ${agentToken}` },
  });
}

async function beginSession(source = 'claude-code', namespace = 'project-x') {
  const res = await agent('/v1/sync_begin', {
    source_system: source,
    source_namespace: namespace,
  });
  expect(res.statusCode, res.body).toBe(200);
  return SyncBeginResult.parse(res.json());
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('a7'.repeat(32)),
    tokenPepper: 'b8'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'c9'.repeat(32), cookieSecure: false },
  });

  admin = new Browser();
  admin.csrf = (
    (await admin.request({ method: 'GET', url: '/v1/auth/csrf' })).json() as {
      token: string;
    }
  ).token;
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

  const created = await admin.post('/v1/admin/agents.create', {
    name: 'Claude Code',
    trust_tier: 'propose',
  });
  const agentId = (created.json() as { agent: { id: string } }).agent.id;
  agentToken = (
    (await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agentId })).json() as {
      token: string;
    }
  ).token;

  expect((await admin.post('/v1/admin/taxonomy.create', { name: 'Architecture' })).statusCode).toBe(
    200,
  );
  expect((await admin.post('/v1/admin/taxonomy.create', { name: 'Marketing' })).statusCode).toBe(
    200,
  );
}, 180_000);

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('beginning a pass', () => {
  it('answers with where to read and where the agent left off', async () => {
    const session = await beginSession();
    expect(session.sync_session_id).toMatch(/^sync_/);
    // Nothing has been completed yet, so there is no checkpoint to resume.
    expect(session.previous_checkpoint).toBeNull();
    expect(session.expires_at > new Date().toISOString()).toBe(true);
    // Where the knowledge is, biggest branch first, so an agent with a budget
    // reads those and stops rather than paging the whole index.
    expect(session.recommended_index_queries.map((q) => q.root_path)).toContain('architecture');
  });

  it('refuses a person, because a checkpoint belongs to an agent and a source', async () => {
    const res = await admin.post('/v1/sync_begin', { source_system: 'by-hand' });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toMatch(/agent protocol/);
  });
});

describe('classifying an inventory', () => {
  it('knows what it already holds, what is merely similar, and what it has not seen', async () => {
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Authentication strategy',
          body: 'Passwordless login uses a six-digit email code.\n',
          type: 'decision',
          categories: ['architecture'],
        })
      ).json(),
    ).item;

    const session = await beginSession();
    const res = await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [
        {
          client_candidate_id: 'c-same-place',
          title: 'Authentication strategy',
          type: 'decision',
          candidate_content_hash: item.content_hash,
          proposed_category_paths: ['architecture'],
        },
        {
          client_candidate_id: 'c-elsewhere',
          title: 'Authentication strategy',
          type: 'decision',
          candidate_content_hash: item.content_hash,
          proposed_category_paths: ['marketing'],
        },
        {
          client_candidate_id: 'c-unseen',
          title: 'How the deploy pipeline works',
          type: 'fact',
          proposed_category_paths: ['architecture'],
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const byId = new Map(
      SyncMatchesResult.parse(res.json()).matches.map((m) => [m.client_candidate_id, m]),
    );

    // The same text in the same place is the same knowledge: skip it.
    expect(byId.get('c-same-place')).toMatchObject({
      classification: 'exact_known',
      classification_state: 'final',
      match_reason: 'content_hash',
    });
    expect(byId.get('c-same-place')?.matched_item_ids).toEqual([item.id]);

    // The same text somewhere else may be different knowledge — the same
    // instruction in two projects is two instructions — so it is a question.
    expect(byId.get('c-elsewhere')).toMatchObject({
      classification: 'likely_match',
      classification_state: 'final',
      match_reason: 'content_hash',
    });

    // Nothing deterministic matched, and no similarity pass has run. Saying
    // `final` here would tell an agent nothing matches when nothing looked.
    expect(byId.get('c-unseen')).toMatchObject({
      classification: 'new_candidate',
      classification_state: 'provisional',
      match_reason: 'none',
    });
  });

  it('decides which side is newer only where the lineage is known', async () => {
    const item = KnowledgeResponse.parse(
      (
        await admin.post('/v1/admin/knowledge.create', {
          title: 'Backup retention',
          body: 'Nightly, kept for thirty days.\n',
          type: 'decision',
          categories: ['architecture'],
          external: { source_system: 'claude-code', external_key: 'ops/backup-retention' },
        })
      ).json(),
    ).item;

    const session = await beginSession();
    const res = await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [
        {
          client_candidate_id: 'c-mine-newer',
          title: 'Backup retention',
          type: 'decision',
          external_key: 'ops/backup-retention',
          source_content_hash: `sha256:${'1'.repeat(64)}`,
          source_modified_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const mine = SyncMatchesResult.parse(res.json()).matches[0]!;
    expect(mine).toMatchObject({
      classification: 'server_copy_stale',
      classification_state: 'final',
      match_reason: 'external_key',
    });
    expect(mine.matched_item_ids).toEqual([item.id]);

    // Without a time from the agent, nothing can be called newer: old text
    // copied into a new file carries today's date.
    const second = await beginSession('claude-code', 'other-project');
    const undated = await agent('/v1/sync_submit_inventory', {
      sync_session_id: second.sync_session_id,
      candidates: [
        {
          client_candidate_id: 'c-undated',
          title: 'Backup retention',
          type: 'decision',
          external_key: 'ops/backup-retention',
          source_content_hash: `sha256:${'2'.repeat(64)}`,
        },
      ],
    });
    expect(SyncMatchesResult.parse(undated.json()).matches[0]).toMatchObject({
      classification: 'conflict',
      classification_state: 'final',
    });
  });

  it('treats a resubmitted batch as the same batch', async () => {
    const session = await beginSession('chatgpt-export', 'personal');
    const batch = {
      sync_session_id: session.sync_session_id,
      candidates: [{ client_candidate_id: 'c-1', title: 'A preference', type: 'preference' }],
    };
    expect((await agent('/v1/sync_submit_inventory', batch)).statusCode).toBe(200);
    expect((await agent('/v1/sync_submit_inventory', batch)).statusCode).toBe(200);

    const status = SyncStatusResult.parse(
      (await agent('/v1/sync_status', { sync_session_id: session.sync_session_id })).json(),
    );
    // One candidate, not two: the key inside a session is the client's own id.
    expect(status.candidate_count).toBe(1);
    expect(status.pending_count).toBe(1);
  });
});

describe('finishing a pass', () => {
  it('writes a checkpoint the next pass resumes from', async () => {
    const session = await beginSession('notes-export', 'notebook');
    await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [{ client_candidate_id: 'c-1', title: 'Something', type: 'fact' }],
    });

    const done = SyncCompleteResult.parse(
      (await agent('/v1/sync_complete', { sync_session_id: session.sync_session_id })).json(),
    );
    expect(done.state).toBe('completed');
    // Where the feed stood when the pass opened, not where it stands now:
    // anything committed while the agent worked is a change it has not seen.
    expect(done.checkpoint.change_sequence).toBe(session.change_sequence);

    const next = await beginSession('notes-export', 'notebook');
    expect(next.previous_checkpoint).toMatchObject({
      sync_session_id: session.sync_session_id,
      change_sequence: session.change_sequence,
    });

    // A finished session is finished: it takes no more inventory.
    const late = await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [{ client_candidate_id: 'c-2', title: 'Too late', type: 'fact' }],
    });
    expect(late.statusCode, late.body).toBe(400);
  });

  it("keeps one agent out of another agent's session", async () => {
    const session = await beginSession('claude-code', 'guarded');
    const other = await admin.post('/v1/admin/agents.create', {
      name: 'Another client',
      trust_tier: 'propose',
    });
    const otherToken = (
      (
        await admin.post('/v1/admin/agents.credentials.issue', {
          agent_id: (other.json() as { agent: { id: string } }).agent.id,
        })
      ).json() as { token: string }
    ).token;

    // An inventory is a list of what an agent knows. It is not another
    // agent's to read.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sync_status',
      payload: { sync_session_id: session.sync_session_id },
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode, res.body).toBe(403);
  });
});

describe('settling what the deterministic steps left open', () => {
  it('turns a provisional candidate into an answer, and says which kind', async () => {
    await admin.post('/v1/admin/knowledge.create', {
      title: 'Deploy pipeline overview',
      body: 'Build, test, push, roll.\n',
      type: 'fact',
      categories: ['architecture'],
    });

    const session = await beginSession('claude-code', 'refinement');
    await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [
        {
          client_candidate_id: 'c-close',
          title: 'Deploy pipeline overview',
          type: 'fact',
          proposed_category_paths: ['architecture'],
        },
        {
          client_candidate_id: 'c-unrelated',
          title: 'What the office wifi password is',
          type: 'fact',
        },
      ],
    });

    const before = SyncStatusResult.parse(
      (await agent('/v1/sync_status', { sync_session_id: session.sync_session_id })).json(),
    );
    expect(before.pending_count).toBe(2);

    // The pass the job runner would run. Called directly, because a test that
    // waits on a queue is a test that fails on a slow machine.
    const settled = await refineSyncSession(
      services,
      session.workspace_id,
      session.sync_session_id,
    );
    expect(settled).toBe(2);

    const after = SyncMatchesResult.parse(
      (await agent('/v1/sync_get_matches', { sync_session_id: session.sync_session_id })).json(),
    );
    expect(after.pending_count).toBe(0);
    const byId = new Map(after.matches.map((m) => [m.client_candidate_id, m]));
    expect(byId.get('c-close')).toMatchObject({
      classification: 'likely_match',
      classification_state: 'final',
      match_reason: 'lexical',
    });
    // Nothing reads like it, and now that is an answer rather than a silence.
    expect(byId.get('c-unrelated')).toMatchObject({
      classification: 'new_candidate',
      classification_state: 'final',
      match_reason: 'none',
    });
  });

  it('costs a query and changes nothing when it runs twice', async () => {
    const session = await beginSession('claude-code', 'idempotent-refinement');
    await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [{ client_candidate_id: 'c-1', title: 'Something else again', type: 'fact' }],
    });
    expect(await refineSyncSession(services, session.workspace_id, session.sync_session_id)).toBe(
      1,
    );
    // A candidate the pass settled is final, and final is never revisited, so
    // a job delivered twice is a job that finds nothing to do.
    expect(await refineSyncSession(services, session.workspace_id, session.sync_session_id)).toBe(
      0,
    );
  });
});

describe('reading a run as a person', () => {
  it('lists the runs with who made them and what they found', async () => {
    const session = await beginSession('claude-code', 'for-people');
    await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [
        { client_candidate_id: 'p-1', title: 'A thing worth knowing', type: 'fact' },
        { client_candidate_id: 'p-2', title: 'Another thing entirely', type: 'fact' },
      ],
    });

    const res = await admin.request({ method: 'GET', url: '/v1/admin/sync.list' });
    expect(res.statusCode, res.body).toBe(200);
    const runs = SyncRunsResponse.parse(res.json()).runs;
    const run = runs.find((r) => r.sync_session_id === session.sync_session_id);
    // Named, because a list of ids is not a list somebody can read.
    expect(run?.agent_name).toBe('Claude Code');
    expect(run?.candidate_count).toBe(2);
    expect(run?.pending_count).toBe(2);
    // Every classification, including the ones nothing fell into: a caller
    // reading counts.conflict should not have to tell none from unsaid.
    expect(run?.counts.conflict).toBe(0);
  });

  it('ties a proposal to the run it came out of, and filters by it', async () => {
    const session = await beginSession('claude-code', 'proposing');
    const proposed = await agent('/v1/knowledge_propose_create', {
      title: 'Something the agent found locally',
      body: 'Worth recording once.\n',
      type: 'fact',
      categories: ['architecture'],
      sync_session_id: session.sync_session_id,
    });
    expect(proposed.statusCode, proposed.body).toBe(202);

    // A reviewer facing ninety proposals from one import wants them together:
    // they were judged by one agent against one body of material.
    const filtered = await admin.post('/v1/proposal_list', {
      sync_session_id: session.sync_session_id,
      limit: 50,
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    const list = ProposalsResponse.parse(filtered.json()).proposals;
    expect(list).toHaveLength(1);
    expect(list[0]?.sync_session_id).toBe(session.sync_session_id);

    // And a different run does not collect it.
    const other = await beginSession('claude-code', 'not-proposing');
    const empty = await admin.post('/v1/proposal_list', {
      sync_session_id: other.sync_session_id,
      limit: 50,
    });
    expect(ProposalsResponse.parse(empty.json()).proposals).toHaveLength(0);
  });
});

describe('what a finished pass leaves behind', () => {
  it('answers from the stats it recorded, not from candidates that may be gone', async () => {
    const session = await beginSession('claude-code', 'retention');
    await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [
        { client_candidate_id: 'r-1', title: 'One thing', type: 'fact' },
        { client_candidate_id: 'r-2', title: 'Another thing', type: 'fact' },
      ],
    });
    await agent('/v1/sync_complete', { sync_session_id: session.sync_session_id });

    // The candidates are one agent's notes about its own material and are
    // pruned; what the pass found has to survive them.
    const removed = await services.uow.run((tx) =>
      services.repositories.sync.deleteCandidatesCompletedBefore(tx, new Date(Date.now() + 1000)),
    );
    expect(removed).toBeGreaterThanOrEqual(2);

    const runs = SyncRunsResponse.parse(
      (await admin.request({ method: 'GET', url: '/v1/admin/sync.list' })).json(),
    ).runs;
    const run = runs.find((r) => r.sync_session_id === session.sync_session_id);
    expect(run?.candidate_count).toBe(2);
    expect(run?.counts.new_candidate).toBe(2);
  });
});

describe('an external identity survives review', () => {
  it('is on the item after approval, so a second pass finds it', async () => {
    // Found by running the protocol against a real instance: three suites
    // passed and the whole external-identity half of reconciliation did
    // nothing, because the payload a proposal stores had no room for it.
    const curator = await admin.post('/v1/admin/agents.create', {
      name: 'Reviewing curator',
      trust_tier: 'trusted',
    });
    const curatorId = (curator.json() as { agent: { id: string } }).agent.id;
    const curatorToken = (
      (await admin.post('/v1/admin/agents.credentials.issue', { agent_id: curatorId })).json() as {
        token: string;
      }
    ).token;
    // Approving is a permission, granted through the route an operator uses.
    const curatorActor = (curator.json() as { agent: { actor_id: string } }).agent.actor_id;
    const granted = await admin.post('/v1/admin/permissions.grant', {
      actor_id: curatorActor,
      action: 'knowledge.approve',
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const proposed = await agent('/v1/knowledge_propose_create', {
      title: 'Where the nightly export lands',
      body: 'A bucket per day, keyed by source.\n',
      type: 'fact',
      categories: ['architecture'],
      external: { source_system: 'claude-code', external_key: 'ops/nightly-export' },
    });
    expect(proposed.statusCode, proposed.body).toBe(202);
    const proposalId = (proposed.json() as { proposal: { id: string } }).proposal.id;

    const approved = await app.inject({
      method: 'POST',
      url: '/v1/proposal_approve',
      payload: { proposal_id: proposalId },
      headers: { authorization: `Bearer ${curatorToken}` },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // The point: a second pass recognises what the first one recorded.
    const session = await beginSession('claude-code', 'external-identity');
    const res = await agent('/v1/sync_submit_inventory', {
      sync_session_id: session.sync_session_id,
      candidates: [
        {
          client_candidate_id: 'e-1',
          title: 'Where the nightly export lands',
          type: 'fact',
          external_key: 'ops/nightly-export',
          source_modified_at: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
    const match = SyncMatchesResult.parse(res.json()).matches[0]!;
    expect(match.match_reason).toBe('external_key');
    // The workspace's copy is newer than the agent's 2020 timestamp.
    expect(match.classification).toBe('agent_copy_stale');
  });
});
