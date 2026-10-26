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
import { newId } from '@knoverge/core';
import { runMigrations, schema } from '@knoverge/db';
import { eq } from 'drizzle-orm';
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

/** One item, and the id it was given. */
async function create(title: string, body: string): Promise<string> {
  const res = await admin.post('/v1/admin/knowledge.create', {
    title,
    body,
    type: 'fact',
    categories: [],
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { item: { id: string } }).item.id;
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
    expect(body.settings.rules).toEqual([
      'duplicate_content_hash',
      'duplicate_text',
      'orphan_source',
      'orphan_attachment',
      'weak_provenance',
      'stale_instruction',
      'empty_category',
      'dangling_alias',
    ]);
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
      // The text rule says nothing about this pair: their content hashes are
      // identical, so it is the other rule's finding, and two rules filing one
      // supersession would be one proposal and one conflict.
      { rule: 'duplicate_text', examined: 2, found: 0, filed: 0, limited: null },
      // Both notice rules ran and both found nothing, which is what a healthy
      // workspace looks like — and a different answer from never having run
      // (ADR 0043).
      { rule: 'orphan_source', examined: 0, found: 0, filed: 0, limited: null },
      { rule: 'orphan_attachment', examined: 0, found: 0, filed: 0, limited: null },
      // Both items here name no source, and the rule says nothing about it: a
      // workspace of two is too small for the habit that makes citing nothing
      // worth saying. It still reports what it read.
      { rule: 'weak_provenance', examined: 2, found: 0, filed: 0, limited: null },
      // And there is nothing here that an agent would be told to follow.
      { rule: 'stale_instruction', examined: 0, found: 0, filed: 0, limited: null },
      // No taxonomy at all in this workspace, so both of the taxonomy rules
      // read nothing — which they still say.
      { rule: 'empty_category', examined: 0, found: 0, filed: 0, limited: null },
      { rule: 'dangling_alias', examined: 0, found: 0, filed: 0, limited: null },
    ]);
    expect(result.run.notices).toEqual([]);

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

describe('a run that finds the same words typed twice', () => {
  it('files the copy, keeps the older, and names what it rested on', async () => {
    // The content hash folds line endings and blank lines and nothing else, so
    // to that rule these are two items. The capitalisation of a title and the
    // spacing of a sentence are not what either of them says.
    const keep = await create(
      'Attachments are kept by their hash',
      'The bytes live under the sha256 of their contents.\n',
    );
    const copy = await create(
      'Attachments Are Kept By Their Hash',
      'The bytes   live under the SHA256 of their contents.\n',
    );

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    const text = result.run.rules.find((rule) => rule.rule === 'duplicate_text');
    expect(text?.filed).toBe(1);

    const listed = await admin.post('/v1/proposal_list', { status: 'pending' });
    const pending = (
      listed.json() as {
        proposals: { proposal_type: string; target_item_id: string; reason: string }[];
      }
    ).proposals.filter((proposal) => proposal.reason.includes('duplicate_text'));
    expect(pending).toHaveLength(1);
    // The copy is the one proposed for supersession, as with the hash rule and
    // for the same reasons: the older item's history is the longer one.
    expect(pending[0]?.proposal_type).toBe('knowledge_supersede');
    expect(pending[0]?.target_item_id).toBe(copy);
    expect(pending[0]?.reason).toContain(keep);
    expect(pending[0]?.reason).toContain('Attachments are kept by their hash');

    // And nothing was written: both are still what the workspace asserts.
    for (const id of [keep, copy]) {
      const res = await admin.post('/v1/knowledge_get', { item_id: id });
      expect((res.json() as { item: { status: string } }).item.status).toBe('active');
    }
  });

  it('leaves two bodies that are merely similar alone', async () => {
    // One sentence longer is not a copy, and what the two should become is a
    // rewrite — which ADR 0039 puts in the optional layer, because a draft is
    // writing and nothing here writes.
    await create('Tokens are opaque', 'A token carries no claims.\n');
    await create('Tokens Are Opaque', 'A token carries no claims. It is looked up.\n');

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(result.run.rules.find((rule) => rule.rule === 'duplicate_text')?.found).toBe(0);
  });
});

describe('a run that sees something naming no write', () => {
  it('records it on the run rather than in the review queue', async () => {
    // Written straight into the table, because there is no route that makes a
    // source reference nothing cites — which is the point of the rule: if one
    // is there, something left it behind.
    const workspace = (await services.repositories.workspaces.findBySlug('personal'))!;
    const orphan = newId('src');
    await services.database.db.insert(schema.sourceReferences).values({
      id: orphan,
      workspaceId: workspace.id,
      sourceType: 'web_url',
      uri: 'https://example.test/forgotten',
      externalSystem: null,
      externalKey: null,
      attachmentId: null,
      sourceModifiedAt: null,
      sourceContentHash: null,
      confidence: null,
      metadata: {},
      createdAt: new Date('2026-02-02T00:00:00Z'),
    });

    const before = (
      (await admin.post('/v1/proposal_list', { status: 'pending' })).json() as {
        proposals: unknown[];
      }
    ).proposals.length;

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(result.run.notices).toHaveLength(1);
    expect(result.run.notices[0]).toMatchObject({
      rule: 'orphan_source',
      subject_type: 'source_reference',
      subject_id: orphan,
    });
    expect(result.run.notices[0]?.reason).toContain('https://example.test/forgotten');
    // Nothing to approve, so nothing arrived in the queue and the run's count
    // of what it left there did not move (ADR 0043).
    const after = (
      (await admin.post('/v1/proposal_list', { status: 'pending' })).json() as {
        proposals: unknown[];
      }
    ).proposals.length;
    expect(after).toBe(before);
    expect(result.run.findings_filed).toBe(0);
  });

  it('says it again on the next run, because it is still true', async () => {
    // No dismissal: a notice about a condition that still holds would be a lie
    // the operator told themselves and the product remembered.
    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(result.run.notices).toHaveLength(1);
  });

  it('is in the run history as the run that saw it', async () => {
    const body = GardeningRunsResponse.parse((await admin.get('/v1/admin/gardening.runs')).json());
    expect(body.runs[0]?.notices[0]?.rule).toBe('orphan_source');
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

describe('a standing order that has run out', () => {
  it('is a notice about the item, and the item is where a reader is sent', async () => {
    // Through the route a person uses, with the date it gave itself already
    // behind us: an instruction is what an agent reading this workspace will
    // follow today, which is why this one is worth saying out loud.
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Freeze releases until the audit closes',
      body: 'No deploys to production while the audit is open.\n',
      type: 'instruction',
      categories: [],
      valid_until: '2026-01-02T03:04:05Z',
    });
    expect(res.statusCode, res.body).toBe(200);
    const itemId = (res.json() as { item: { id: string } }).item.id;

    const before = (
      (await admin.post('/v1/proposal_list', { status: 'pending' })).json() as {
        proposals: unknown[];
      }
    ).proposals.length;

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    const notice = result.run.notices.find((entry) => entry.rule === 'stale_instruction');
    expect(notice).toMatchObject({ subject_type: 'knowledge_item', subject_id: itemId });
    expect(notice?.reason).toContain('stopped being valid on 2026-01-02T03:04:05');
    // Nothing is proposed: whether this should be deleted, re-dated or
    // rewritten is exactly what the installation cannot know (ADR 0039), so
    // the review queue is where it does not go (ADR 0043).
    const after = (
      (await admin.post('/v1/proposal_list', { status: 'pending' })).json() as {
        proposals: unknown[];
      }
    ).proposals.length;
    expect(
      after - before,
      'a notice is not a proposal, so only the duplicate rule may have filed',
    ).toBeLessThanOrEqual(1);
  });
});

describe('a taxonomy somebody laid out and left', () => {
  beforeAll(async () => {
    // The caps above left this workspace filing one finding per rule, and two
    // names left on one category is exactly what the last of these is about.
    const res = await admin.post('/v1/admin/gardening.save', {
      enabled: true,
      interval_hours: 12,
      max_findings_per_run: 50,
      max_findings_per_rule: 20,
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  /** One category, through the route a curator uses. */
  async function category(name: string, aliases: string[] = []): Promise<string> {
    const res = await admin.post('/v1/admin/taxonomy.create', { name, aliases });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { category: { id: string } }).category.id;
  }

  it('is a notice about the category, once it has been empty for a month', async () => {
    const categoryId = await category('Retired experiments');

    // Nothing is said about it yet: a taxonomy is often laid out before the
    // knowledge arrives, and a rule that reported this the same afternoon
    // would be arguing with the way the screen is meant to be used.
    const fresh = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    expect(fresh.run.rules.find((rule) => rule.rule === 'empty_category')).toMatchObject({
      // Read and left alone, which is not the same answer as never having run.
      examined: 1,
      found: 0,
    });

    // A month passing, which is the one thing a test cannot wait for. The
    // column is what the rule compares against, so this is the state rather
    // than a stand-in for it.
    await services.database.db
      .update(schema.categories)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.categories.id, categoryId));

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    const notice = result.run.notices.find((entry) => entry.rule === 'empty_category');
    expect(notice).toMatchObject({ subject_type: 'category', subject_id: categoryId });
    expect(notice?.reason).toContain('retired-experiments');
    expect(notice?.reason).toContain('no category under it');
  });

  it('says nothing about a category knowledge is filed in', async () => {
    const categoryId = await category('In use');
    await services.database.db
      .update(schema.categories)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.categories.id, categoryId));
    const res = await admin.post('/v1/admin/knowledge.create', {
      title: 'Where the audit log lives',
      body: 'In PostgreSQL, hash-chained.\n',
      type: 'fact',
      categories: ['in-use'],
    });
    expect(res.statusCode, res.body).toBe(200);

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    const notices = result.run.notices.filter(
      (entry) => entry.rule === 'empty_category' && entry.subject_id === categoryId,
    );
    expect(notices).toEqual([]);
  });

  it('is a notice about the name left behind, once the category is archived', async () => {
    const categoryId = await category('Pixel Brisbane', ['pixel', 'brisbane project']);
    expect(
      (await admin.post('/v1/admin/taxonomy.archive', { category_id: categoryId })).statusCode,
    ).toBe(200);

    const result = RunGardeningResponse.parse(
      (await admin.post('/v1/admin/gardening.run', {})).json(),
    );
    const notices = result.run.notices.filter((entry) => entry.rule === 'dangling_alias');
    // One per name, because two names left on one category are two names, and
    // each is refused to whatever category wants it next.
    expect(notices.map((entry) => entry.subject_type)).toEqual([
      'category_alias',
      'category_alias',
    ]);
    expect(notices.every((entry) => entry.subject_id.startsWith('alias_'))).toBe(true);
    expect(notices.map((entry) => entry.reason).join(' ')).toContain('pixel-brisbane');
    expect(notices.some((entry) => entry.reason.includes('"pixel"'))).toBe(true);
    expect(notices.some((entry) => entry.reason.includes('"brisbane project"'))).toBe(true);
    expect(notices.every((entry) => entry.reason.includes('archived'))).toBe(true);
  });
});
