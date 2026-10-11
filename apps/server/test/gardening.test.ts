import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GardeningRunsResponse,
  GardeningSettingsResponse,
  RunGardeningResponse,
  TERMS_VERSION,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-gardening-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('a1'.repeat(32)),
    tokenPepper: 'b2'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'c3'.repeat(32), cookieSecure: false },
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
  const created = await admin.post('/v1/admin/agents.create', {
    name: 'A curious agent',
    trust_tier: 'trusted',
  });
  agentToken = (
    (
      await admin.post('/v1/admin/agents.credentials.issue', {
        agent_id: (created.json() as { agent: { id: string } }).agent.id,
      })
    ).json() as { token: string }
  ).token;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * The same assertion, written twice.
 *
 * `knowledge.create` is the direct route a person uses, and it runs no
 * duplicate screen: that screen is on proposing, so an agent cannot fill a
 * workspace with what it already holds. A person pasting the same thing twice
 * is precisely the mess gardening exists to notice.
 */
async function twice(title: string, body: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await admin.post('/v1/admin/knowledge.create', {
      title,
      body,
      type: 'fact',
      categories: [],
    });
    expect(res.statusCode, res.body).toBe(200);
    ids.push((res.json() as { item: { id: string } }).item.id);
  }
  return ids;
}

describe('a workspace nobody has configured', () => {
  it('says gardening is off, rather than saying nothing', async () => {
    const body = GardeningSettingsResponse.parse(
      (await admin.get('/v1/admin/gardening.settings')).json(),
    );
    expect(body.settings).toMatchObject({
      enabled: false,
      interval_hours: 24,
      max_findings_per_run: 50,
      max_findings_per_rule: 20,
      last_run_at: null,
    });
    // Every rule the installation has, so the screen can name one that found
    // nothing rather than showing an empty list.
    expect(body.settings.rules).toEqual(['duplicate_content_hash']);
  });

  it('has no runs to show', async () => {
    const body = GardeningRunsResponse.parse((await admin.get('/v1/admin/gardening.runs')).json());
    expect(body.runs).toEqual([]);
  });

  it('is not something an agent may see, run or change', async () => {
    // Administration, not tools: no agent trust tier holds workspace.admin and
    // an agent has no MCP name to reach these by (rule 11, ADR 0011).
    for (const url of ['/v1/admin/gardening.settings', '/v1/admin/gardening.runs']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode, url).toBe(403);
    }
    for (const url of ['/v1/admin/gardening.save', '/v1/admin/gardening.run']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { enabled: true },
      });
      expect(res.statusCode, url).toBe(403);
    }
  });
});

describe('a run that finds the same thing twice', () => {
  it('files a proposal and changes nothing', async () => {
    const [first, second] = await twice(
      'The ledger key never goes in the database',
      'It is read from the environment at start-up.\n',
    );

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(result.run.findings_filed).toBe(1);
    expect(result.run.rules).toEqual([
      { rule: 'duplicate_content_hash', examined: 2, found: 1, filed: 1, limited: null },
    ]);

    // The whole of ADR 0042 in one assertion. The gardener runs as the
    // workspace system actor, and a system actor is the host operator at the
    // command line, whose default policy effect is `allow_direct` — so a
    // gardener that proposed the way an agent proposes would have superseded
    // this item without asking anybody.
    const listed = await admin.post('/v1/proposal_list', { status: 'pending' });
    const proposals = listed.json() as {
      proposals: { id: string; proposal_type: string; target_item_id: string; reason: string }[];
    };
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      proposal_type: 'knowledge_supersede',
      // The copy is the one proposed for supersession; the older survives.
      target_item_id: second,
    });
    // And it names the rule and the rows it read, so a reviewer can disagree
    // with the rule rather than with the finding (ADR 0039).
    expect(proposals.proposals[0]?.reason).toContain('duplicate_content_hash');
    expect(proposals.proposals[0]?.reason).toContain(first as string);

    // Nothing was written. Both items are still what the workspace asserts.
    for (const id of [first, second]) {
      const res = await admin.post('/v1/knowledge_get', { item_id: id });
      expect((res.json() as { item: { status: string } }).item.status).toBe('active');
    }
  });

  it('does not file it again while somebody is still looking at it', async () => {
    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(result.run.findings_filed).toBe(0);
    // Nothing to find, rather than something found and not filed: the pair is
    // in the review queue, so the scan does not count it. A screen reporting
    // "found 1, filed 0" every day would be telling an operator that the
    // gardener was stuck.
    expect(result.run.rules[0]).toEqual({
      rule: 'duplicate_content_hash',
      examined: 2,
      found: 0,
      filed: 0,
      limited: null,
    });
  });

  it('records the run, who asked for it, and what each rule did', async () => {
    const body = GardeningRunsResponse.parse((await admin.get('/v1/admin/gardening.runs')).json());
    expect(body.runs).toHaveLength(2);
    // Newest first, and both were asked for here rather than by the schedule.
    expect(body.runs.map((run) => run.trigger)).toEqual(['requested', 'requested']);
    expect(body.runs[0]?.finished_at).not.toBeNull();
    expect(body.runs[1]?.findings_filed).toBe(1);
  });

  it('moves the schedule on, so the settings say when it last looked', async () => {
    const body = GardeningSettingsResponse.parse(
      (await admin.get('/v1/admin/gardening.settings')).json(),
    );
    expect(body.settings.last_run_at).not.toBeNull();
  });
});

describe('a finding the workspace has moved past', () => {
  it('is refused by the filing path rather than applied to the wrong revision', async () => {
    // Through the service rather than the route, because a run scans and files
    // in one call and there is no moment in between to reach from outside. The
    // moment exists all the same: a scan reads what was true when it ran, and
    // somebody can edit either item while it is still filing.
    const [first, second] = await twice(
      'Rule 6 applies to a finding as much as to a person',
      'The base travels with it.\n',
    );
    const workspace = (await services.repositories.workspaces.findBySlug('personal'))!;
    const actor = (await services.repositories.actors.findSystemActor(workspace.id))!;
    const item = (await services.repositories.knowledge.findById(workspace.id, second as never))!;

    await expect(
      services.proposals.fileSupersedeFinding(
        {
          workspaceId: workspace.id,
          actorId: actor.id,
          actorType: 'system',
          requestId: 'gardening-stale',
          client: 'gardener',
        },
        {
          oldItemId: second as never,
          oldBaseRevisionId: item.currentRevisionId as never,
          // What the scan read, a revision ago.
          oldBaseContentHash: 'sha256:what-it-used-to-say',
          existingItem: {
            itemId: first as never,
            baseRevisionId: item.currentRevisionId as never,
            baseContentHash: 'sha256:also-stale',
          },
          reason: 'gardening rule duplicate_content_hash: a stale finding',
        },
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
});

describe('the caps', () => {
  it('are saved together with the schedule, and hold the run to what they say', async () => {
    const saved = GardeningSettingsResponse.parse(
      (
        await admin.post('/v1/admin/gardening.save', {
          enabled: true,
          interval_hours: 12,
          max_findings_per_run: 1,
          max_findings_per_rule: 1,
        })
      ).json(),
    );
    expect(saved.settings).toMatchObject({
      enabled: true,
      interval_hours: 12,
      max_findings_per_run: 1,
      max_findings_per_rule: 1,
    });

    await twice('The first of two more', 'One body.\n');
    await twice('The second of two more', 'Another body.\n');

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(result.run.findings_filed).toBe(1);
    expect(result.run.reached_cap).toBe(true);
    // Found more than it filed, and said which cap stopped it. What was not
    // filed is not lost: the next run finds it again.
    expect(result.run.rules[0]?.found).toBeGreaterThan(1);
    expect(result.run.rules[0]?.limited).toBe('run_cap');
  });

  it('refuse a number the database would not hold', async () => {
    const res = await admin.post('/v1/admin/gardening.save', {
      enabled: true,
      interval_hours: 12,
      max_findings_per_run: 5000,
      max_findings_per_rule: 1,
    });
    // At the boundary rather than in the constraint: a 500 from a CHECK is the
    // same refusal with none of the explanation.
    expect(res.statusCode).toBe(400);
  });
});
