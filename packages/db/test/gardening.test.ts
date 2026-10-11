import { fileURLToPath } from 'node:url';

import type {
  ActorId,
  KnowledgeItemId,
  ProposalId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';
import {
  EventLedger,
  WorkspaceService,
  newId,
  parseLedgerKey,
  type GardeningRunRecord,
} from '@knoverge/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createActorRepository,
  createDatabase,
  createEventRepository,
  createGardeningRepository,
  createKnowledgeRepository,
  createProposalRepository,
  createRevisionRepository,
  createSearchRepository,
  createUnitOfWork,
  createWorkspaceRepository,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let uow: ReturnType<typeof createUnitOfWork>;
let gardening: ReturnType<typeof createGardeningRepository>;
let knowledge: ReturnType<typeof createKnowledgeRepository>;
let revisions: ReturnType<typeof createRevisionRepository>;
let proposals: ReturnType<typeof createProposalRepository>;
let search: ReturnType<typeof createSearchRepository>;
let workspaceId: WorkspaceId;
let otherWorkspaceId: WorkspaceId;
let actorId: ActorId;
let workspaceService: WorkspaceService;

const at = (hour: number) => new Date(Date.UTC(2026, 9, 11, hour));

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);
  uow = createUnitOfWork(handle.db);
  gardening = createGardeningRepository(handle.db);
  knowledge = createKnowledgeRepository(handle.db);
  revisions = createRevisionRepository(handle.db);
  proposals = createProposalRepository(handle.db);
  search = createSearchRepository(handle.db);

  const actors = createActorRepository(handle.db);
  workspaceService = new WorkspaceService({
    uow,
    workspaces: createWorkspaceRepository(handle.db),
    actors,
    ledger: new EventLedger({
      key: parseLedgerKey('d'.repeat(64)),
      events: createEventRepository(handle.db),
    }),
  });
  workspaceId = (
    await workspaceService.create({ slug: 'garden', name: 'Garden', requestId: 'req-1' })
  ).id;
  otherWorkspaceId = (
    await workspaceService.create({ slug: 'elsewhere', name: 'Elsewhere', requestId: 'req-2' })
  ).id;
  actorId = (await actors.findSystemActor(workspaceId))!.id;
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
});

/** One active item asserting `body` under `title`, as of `createdAt`. */
async function item(options: {
  slug: string;
  contentHash: string;
  createdAt: Date;
  workspace?: WorkspaceId;
  status?: 'active' | 'superseded';
  /** What the revision calls it. The slug, where a test does not care. */
  title?: string;
}): Promise<{ itemId: KnowledgeItemId; revisionId: RevisionId }> {
  const workspace = options.workspace ?? workspaceId;
  const itemId = newId('kn') as KnowledgeItemId;
  const revisionId = newId('rev') as RevisionId;
  await uow.run(async (tx) => {
    await knowledge.insert(tx, {
      id: itemId,
      workspaceId: workspace,
      slug: options.slug,
      markdownPath: `knowledge/_uncategorised/${options.slug}.md`,
      type: 'fact',
      status: options.status ?? 'active',
      language: 'en',
      currentRevisionId: null,
      reviewState: 'unreviewed',
      evidenceState: 'none',
      disputed: false,
      validFrom: null,
      validUntil: null,
      observedAt: null,
      sourceSystem: null,
      externalKey: null,
      createdByActorId: (await createActorRepository(handle.db).findSystemActor(workspace))!.id,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      deletedAt: null,
    });
    await revisions.insert(tx, {
      id: revisionId,
      knowledgeItemId: itemId,
      workspaceId: workspace,
      revisionNumber: 1,
      contentHash: options.contentHash,
      frontmatterHash: 'sha256:fm',
      gitCommitHash: 'c'.repeat(40),
      title: options.title ?? `title ${options.slug}`,
      markdownPath: `knowledge/_uncategorised/${options.slug}.md`,
      frontmatter: {} as never,
      changeKind: 'create',
      createdByActorId: (await createActorRepository(handle.db).findSystemActor(workspace))!.id,
      createdAt: options.createdAt,
      operationId: newId('op'),
      reason: null,
    });
    await knowledge.update(tx, itemId, { currentRevisionId: revisionId });
  });
  return { itemId, revisionId };
}

function run(overrides: Partial<GardeningRunRecord> = {}): GardeningRunRecord {
  return {
    id: newId('grun'),
    workspaceId,
    trigger: 'scheduled',
    startedAt: at(1),
    finishedAt: null,
    findingsFiled: 0,
    reachedCap: false,
    error: null,
    rules: [],
    ...overrides,
  };
}

describe('the settings a workspace has before anybody configures them', () => {
  it('are the defaults, with no row to read', async () => {
    // Unlike the backup settings, which the migration inserts: there is one of
    // those and one per workspace of these, and a backfill would be a thing
    // workspace creation and import both had to remember (ADR 0042).
    const settings = await gardening.settings(otherWorkspaceId);
    expect(settings).toMatchObject({
      workspaceId: otherWorkspaceId,
      enabled: false,
      intervalHours: 24,
      maxFindingsPerRun: 50,
      maxFindingsPerRule: 20,
      lastRunAt: null,
    });
  });

  it('and the row appears the first time something is changed', async () => {
    await uow.run((tx) => gardening.save(tx, workspaceId, { enabled: true }, at(2)));
    expect(await gardening.settings(workspaceId)).toMatchObject({
      enabled: true,
      // The defaults came with it rather than nulls.
      intervalHours: 24,
      maxFindingsPerRun: 50,
    });
  });

  it('leaves alone what a patch says nothing about', async () => {
    await uow.run((tx) =>
      gardening.save(tx, workspaceId, { maxFindingsPerRun: 7, intervalHours: 6 }, at(3)),
    );
    await uow.run((tx) => gardening.save(tx, workspaceId, { lastRunAt: at(4) }, at(4)));

    const settings = await gardening.settings(workspaceId);
    // A run recording when it ran must not put back a schedule somebody
    // changed while it was running.
    expect(settings.maxFindingsPerRun).toBe(7);
    expect(settings.intervalHours).toBe(6);
    expect(settings.lastRunAt).toEqual(at(4));
    expect(settings.enabled).toBe(true);
  });
});

/** What one test left behind is not what the next one is about. */
async function clear(table: 'gardening_settings' | 'gardening_runs') {
  await handle.db.execute(sql`delete from ${sql.identifier(table)}`);
}

/**
 * A workspace of its own, for a test that counts what a workspace holds.
 *
 * Knowledge cannot be cleared between tests: a revision is append-only and the
 * trigger that says so refuses the cascade. Which is the right way round — so
 * the tests that count items get somewhere nobody else has written.
 */
let fresh = 0;
async function emptyWorkspace(): Promise<WorkspaceId> {
  fresh += 1;
  const created = await workspaceService.create({
    slug: `fresh-${fresh}`,
    name: `Fresh ${fresh}`,
    requestId: `req-fresh-${fresh}`,
  });
  return created.id;
}

describe('which workspaces are due', () => {
  beforeEach(() => clear('gardening_settings'));

  it('is nobody when gardening is off, whatever the interval says', async () => {
    await uow.run((tx) =>
      gardening.save(tx, workspaceId, { enabled: false, intervalHours: 1 }, at(1)),
    );
    expect(await gardening.due(at(20))).toEqual([]);
  });

  it('is a workspace that has never run, as soon as it is turned on', async () => {
    await uow.run((tx) => gardening.save(tx, workspaceId, { enabled: true }, at(1)));
    expect(await gardening.due(at(1))).toEqual([workspaceId]);
  });

  it('is not a workspace that ran inside its interval', async () => {
    await uow.run((tx) =>
      gardening.save(
        tx,
        workspaceId,
        { enabled: true, intervalHours: 24, lastRunAt: at(10) },
        at(10),
      ),
    );
    expect(await gardening.due(at(20))).toEqual([]);
    // And is, once the interval has passed. The hours are the setting's, not
    // the scheduler's: the queue asks every hour and usually finds nothing.
    expect(await gardening.due(new Date(Date.UTC(2026, 9, 12, 11)))).toEqual([workspaceId]);
  });
});

describe('a run record', () => {
  beforeEach(() => clear('gardening_runs'));

  it('is written before the rules are read and finished afterwards', async () => {
    const started = run({ startedAt: at(5) });
    await uow.run((tx) => gardening.insertRun(tx, started));

    const [open] = await gardening.runs(workspaceId, 10);
    // Null while it runs, which is also how a run a restart interrupted is
    // recognisable as one that never finished.
    expect(open?.finishedAt).toBeNull();

    await uow.run((tx) =>
      gardening.finishRun(tx, {
        ...started,
        finishedAt: at(6),
        findingsFiled: 3,
        reachedCap: true,
        error: null,
        rules: [
          {
            rule: 'duplicate_content_hash',
            examined: 120,
            found: 9,
            filed: 3,
            limited: 'run_cap',
          },
        ],
      }),
    );

    const [finished] = await gardening.runs(workspaceId, 10);
    expect(finished).toMatchObject({
      finishedAt: at(6),
      findingsFiled: 3,
      reachedCap: true,
    });
    // The per-rule block survives the round trip, numbers and reason both.
    expect(finished?.rules).toEqual([
      { rule: 'duplicate_content_hash', examined: 120, found: 9, filed: 3, limited: 'run_cap' },
    ]);
  });

  it('comes back newest first, and only for its own workspace', async () => {
    await uow.run(async (tx) => {
      await gardening.insertRun(tx, run({ startedAt: at(7) }));
      await gardening.insertRun(tx, run({ startedAt: at(8) }));
      await gardening.insertRun(tx, run({ startedAt: at(9), workspaceId: otherWorkspaceId }));
    });
    const runs = await gardening.runs(workspaceId, 10);
    expect(runs.map((record) => record.startedAt)).toEqual([at(8), at(7)]);
  });
});

describe('the hashes more than one active item asserts', () => {
  let here: WorkspaceId;
  let gardener: ActorId;
  const gardenerIn = (workspace: WorkspaceId) => (workspace === here ? gardener : actorId);
  beforeEach(async () => {
    here = await emptyWorkspace();
    gardener = (await createActorRepository(handle.db).findSystemActor(here))!.id;
  });

  it('finds a pair, oldest first, and counts what it read', async () => {
    const first = await item({
      slug: 'a1',
      contentHash: 'sha256:same',
      createdAt: at(1),
      workspace: here,
    });
    const second = await item({
      slug: 'a2',
      contentHash: 'sha256:same',
      createdAt: at(2),
      workspace: here,
    });
    await item({ slug: 'a3', contentHash: 'sha256:alone', createdAt: at(3), workspace: here });

    const scan = await gardening.duplicateContentHashes(here, gardenerIn(here), 10);
    expect(scan.examined).toBe(3);
    // One group of two is one finding: the copy, not the pair.
    expect(scan.duplicates).toBe(1);
    expect(scan.groups).toHaveLength(1);
    expect(scan.groups[0]?.members.map((member) => member.itemId)).toEqual([
      first.itemId,
      second.itemId,
    ]);
    expect(scan.groups[0]?.members[0]?.revisionId).toBe(first.revisionId);
  });

  it('counts a group of three as two findings', async () => {
    await item({ slug: 'b1', contentHash: 'sha256:three', createdAt: at(1), workspace: here });
    await item({ slug: 'b2', contentHash: 'sha256:three', createdAt: at(2), workspace: here });
    await item({ slug: 'b3', contentHash: 'sha256:three', createdAt: at(3), workspace: here });

    const scan = await gardening.duplicateContentHashes(here, gardenerIn(here), 10);
    expect(scan.duplicates).toBe(2);
    expect(scan.groups[0]?.members).toHaveLength(3);
  });

  it('ignores an item that is no longer what the workspace asserts', async () => {
    await item({ slug: 'c1', contentHash: 'sha256:gone', createdAt: at(1), workspace: here });
    await item({
      slug: 'c2',
      contentHash: 'sha256:gone',
      createdAt: at(2),
      workspace: here,
      status: 'superseded',
    });

    const scan = await gardening.duplicateContentHashes(here, gardenerIn(here), 10);
    // A superseded item saying the same thing is history, and proposing to
    // supersede it again would be proposing nothing.
    expect(scan.groups).toHaveLength(0);
    expect(scan.duplicates).toBe(0);
    expect(scan.examined).toBe(1);
  });

  it('never crosses a workspace', async () => {
    await item({ slug: 'd1', contentHash: 'sha256:shared', createdAt: at(1), workspace: here });
    await item({
      slug: 'd2',
      contentHash: 'sha256:shared',
      createdAt: at(2),
      workspace: otherWorkspaceId,
    });

    expect(
      (await gardening.duplicateContentHashes(here, gardenerIn(here), 10)).groups,
    ).toHaveLength(0);
    expect(
      (await gardening.duplicateContentHashes(otherWorkspaceId, gardenerIn(otherWorkspaceId), 10))
        .groups,
    ).toHaveLength(0);
  });

  it('returns the groups asked for and still says how many there are', async () => {
    await item({ slug: 'e1', contentHash: 'sha256:e', createdAt: at(1), workspace: here });
    await item({ slug: 'e2', contentHash: 'sha256:e', createdAt: at(2), workspace: here });
    await item({ slug: 'f1', contentHash: 'sha256:f', createdAt: at(3), workspace: here });
    await item({ slug: 'f2', contentHash: 'sha256:f', createdAt: at(4), workspace: here });

    const scan = await gardening.duplicateContentHashes(here, gardenerIn(here), 1);
    expect(scan.groups).toHaveLength(1);
    // The oldest group, so what a capped run files is the oldest mess rather
    // than an arbitrary slice of it.
    expect(scan.groups[0]?.contentHash).toBe('sha256:e');
    expect(scan.duplicates).toBe(2);
  });

  it('reports how much it read even when it found nothing', async () => {
    await item({ slug: 'g1', contentHash: 'sha256:g1', createdAt: at(1), workspace: here });
    await item({ slug: 'g2', contentHash: 'sha256:g2', createdAt: at(2), workspace: here });

    const scan = await gardening.duplicateContentHashes(here, gardenerIn(here), 10);
    // The counts come back with the rows, and there are no rows — so a rule
    // that found nothing would have reported reading nothing.
    expect(scan.examined).toBe(2);
    expect(scan.duplicates).toBe(0);
  });
});

describe('the items the scan leaves out', () => {
  let here: WorkspaceId;
  let gardener: ActorId;

  beforeEach(async () => {
    here = await emptyWorkspace();
    gardener = (await createActorRepository(handle.db).findSystemActor(here))!.id;
  });

  /** One proposal about `itemId`, in whatever state the test is about. */
  async function proposal(options: {
    itemId: KnowledgeItemId;
    status: 'pending' | 'conflict' | 'rejected' | 'approved';
    by: ActorId;
  }) {
    const resolved = options.status === 'pending';
    await uow.run((tx) =>
      proposals.insert(tx, {
        id: newId('prop') as ProposalId,
        workspaceId: here,
        proposalType: 'knowledge_supersede',
        targetItemId: options.itemId,
        targetCategoryId: null,
        status: options.status,
        proposedByActorId: options.by,
        baseRevisionId: null,
        baseContentHash: null,
        proposedPayload: {},
        reason: null,
        confidence: null,
        acknowledgedDuplicateIds: [],
        syncSessionId: null,
        policyDecision: 'require_review',
        policyRuleId: null,
        createdAt: at(1),
        // A proposal that is not pending names who ended it; the constraint in
        // the migration says so, including for a conflict.
        resolvedAt: resolved ? null : at(2),
        resolvedByActorId: resolved ? null : options.by,
        resolutionNote: null,
        resultRevisionIds: [],
      }),
    );
  }

  it('are the ones with a proposal waiting, at either end of the pair', async () => {
    const survivor = await item({
      slug: 'p1',
      contentHash: 'sha256:p',
      createdAt: at(1),
      workspace: here,
    });
    await item({ slug: 'p2', contentHash: 'sha256:p', createdAt: at(2), workspace: here });
    await proposal({ itemId: survivor.itemId, status: 'pending', by: actorId });

    // A reviewer is already looking at one of them, and a supersession changes
    // both — so there is nothing here to propose.
    const scan = await gardening.duplicateContentHashes(here, gardener, 10);
    expect(scan.groups).toHaveLength(0);
    expect(scan.duplicates).toBe(0);
    // And it still says what it read: the items are there, they are just not
    // something to file about.
    expect(scan.examined).toBe(2);
  });

  it('are the ones in conflict, which are also waiting for a person', async () => {
    const copy = await item({
      slug: 'q1',
      contentHash: 'sha256:q',
      createdAt: at(1),
      workspace: here,
    });
    await item({ slug: 'q2', contentHash: 'sha256:q', createdAt: at(2), workspace: here });
    await proposal({ itemId: copy.itemId, status: 'conflict', by: gardener });

    expect((await gardening.duplicateContentHashes(here, gardener, 10)).groups).toHaveLength(0);
  });

  it('are the ones whose gardening proposal this gardener had refused', async () => {
    const copy = await item({
      slug: 'r1',
      contentHash: 'sha256:r',
      createdAt: at(1),
      workspace: here,
    });
    await item({ slug: 'r2', contentHash: 'sha256:r', createdAt: at(2), workspace: here });
    await proposal({ itemId: copy.itemId, status: 'rejected', by: gardener });

    // A reviewer who said no has answered the rule, and asking again tomorrow
    // is nagging rather than tidying.
    expect((await gardening.duplicateContentHashes(here, gardener, 10)).groups).toHaveLength(0);
  });

  it('are not the ones somebody else proposed and was refused for', async () => {
    const copy = await item({
      slug: 's1',
      contentHash: 'sha256:s',
      createdAt: at(1),
      workspace: here,
    });
    await item({ slug: 's2', contentHash: 'sha256:s', createdAt: at(2), workspace: here });
    await proposal({ itemId: copy.itemId, status: 'rejected', by: actorId });

    // Somebody else's proposal being turned down says nothing about what a rule
    // should notice.
    expect((await gardening.duplicateContentHashes(here, gardener, 10)).groups).toHaveLength(1);
  });

  it('are not the ones whose proposal was decided and applied', async () => {
    const copy = await item({
      slug: 't1',
      contentHash: 'sha256:t',
      createdAt: at(1),
      workspace: here,
    });
    await item({ slug: 't2', contentHash: 'sha256:t', createdAt: at(2), workspace: here });
    await proposal({ itemId: copy.itemId, status: 'approved', by: gardener });

    // An approved proposal is a decision that has been carried out. If the item
    // is still a duplicate afterwards, that is a new fact about now.
    expect((await gardening.duplicateContentHashes(here, gardener, 10)).groups).toHaveLength(1);
  });

  it('do not starve a capped scan of the mess nobody has looked at yet', async () => {
    // The case a cap makes dangerous. The refused pair is the oldest, a cap
    // takes the oldest groups first, and filtering after the query would mean
    // this workspace never filed anything again.
    const refused = await item({
      slug: 'u1',
      contentHash: 'sha256:u',
      createdAt: at(1),
      workspace: here,
    });
    await item({ slug: 'u2', contentHash: 'sha256:u', createdAt: at(2), workspace: here });
    await proposal({ itemId: refused.itemId, status: 'rejected', by: gardener });

    await item({ slug: 'v1', contentHash: 'sha256:v', createdAt: at(3), workspace: here });
    await item({ slug: 'v2', contentHash: 'sha256:v', createdAt: at(4), workspace: here });

    const scan = await gardening.duplicateContentHashes(here, gardener, 1);
    expect(scan.groups).toHaveLength(1);
    expect(scan.groups[0]?.contentHash).toBe('sha256:v');
    expect(scan.duplicates).toBe(1);
  });

  it('keeps the rest of a group when one of its members is held', async () => {
    const survivor = await item({
      slug: 'w1',
      contentHash: 'sha256:w',
      createdAt: at(1),
      workspace: here,
    });
    const refused = await item({
      slug: 'w2',
      contentHash: 'sha256:w',
      createdAt: at(2),
      workspace: here,
    });
    const third = await item({
      slug: 'w3',
      contentHash: 'sha256:w',
      createdAt: at(3),
      workspace: here,
    });
    await proposal({ itemId: refused.itemId, status: 'rejected', by: gardener });

    // One member drops out and the other two are still the same thing twice.
    // Excluding the whole group instead would let one refusal hide a copy
    // nobody had seen.
    const scan = await gardening.duplicateContentHashes(here, gardener, 10);
    expect(scan.groups[0]?.members.map((member) => member.itemId)).toEqual([
      survivor.itemId,
      third.itemId,
    ]);
    expect(scan.duplicates).toBe(1);
  });
});

describe('the text more than one active item holds', () => {
  let here: WorkspaceId;
  let gardener: ActorId;

  beforeEach(async () => {
    here = await emptyWorkspace();
    gardener = (await createActorRepository(handle.db).findSystemActor(here))!.id;
  });

  /**
   * One item, indexed: a revision and the lexical index over it.
   *
   * The index is where the candidates come from, and the write path fills it in
   * the same transaction as the revision — so a test that writes one without
   * the other is testing a state the application does not produce.
   */
  async function written(options: {
    slug: string;
    title: string;
    chunks: string[];
    createdAt: Date;
    contentHash?: string;
    /** For the one test about an index left behind by an older revision. */
    indexRevisionId?: RevisionId;
  }): Promise<{ itemId: KnowledgeItemId; revisionId: RevisionId }> {
    const written = await item({
      slug: options.slug,
      title: options.title,
      contentHash: options.contentHash ?? `sha256:${options.slug}`,
      createdAt: options.createdAt,
      workspace: here,
    });
    await uow.run((tx) =>
      search.upsert(tx, {
        knowledgeItemId: written.itemId,
        workspaceId: here,
        revisionId: options.indexRevisionId ?? written.revisionId,
        language: 'en',
        title: options.title,
        chunks: options.chunks.map((text, ordinal) => ({ ordinal, text })),
        updatedAt: options.createdAt,
      }),
    );
    return written;
  }

  it('pairs the copy against the oldest, and counts what it could compare', async () => {
    const keep = await written({
      slug: 't1',
      title: 'Authentication strategy',
      chunks: ['A six-digit email code.'],
      createdAt: at(1),
    });
    const copy = await written({
      slug: 't2',
      // Capitalisation in both, which is exactly what the content hash does
      // not fold and what this rule exists for.
      title: 'Authentication Strategy',
      chunks: ['A SIX-DIGIT   email code.'],
      createdAt: at(2),
    });
    await written({
      slug: 't3',
      title: 'Something else entirely',
      chunks: ['Different words.'],
      createdAt: at(3),
    });

    const scan = await gardening.duplicateTexts(here, gardener, 10);
    expect(scan.examined).toBe(3);
    expect(scan.duplicates).toBe(1);
    expect(scan.pairs).toHaveLength(1);
    expect(scan.pairs[0]?.survivor.itemId).toBe(keep.itemId);
    expect(scan.pairs[0]?.copy.itemId).toBe(copy.itemId);
    // Both ends carry what the scan read, because rule 6 travels with a
    // finding as much as with a person.
    expect(scan.pairs[0]?.survivor.revisionId).toBe(keep.revisionId);
    expect(scan.pairs[0]?.copy.contentHash).toBe('sha256:t2');
    expect(scan.pairs[0]?.survivor.title).toBe('Authentication strategy');
  });

  it('reads all of an item, not the chunk that happens to come first', async () => {
    // A body is several chunks, and comparing one of them would call two items
    // the same because their opening paragraph is.
    await written({
      slug: 'u1',
      title: 'Two paragraphs',
      chunks: ['The opening both of them share.', 'Only the first says this.'],
      createdAt: at(1),
    });
    await written({
      slug: 'u2',
      title: 'Two Paragraphs',
      chunks: ['The opening both of them share.', 'And the second says something else.'],
      createdAt: at(2),
    });

    expect((await gardening.duplicateTexts(here, gardener, 10)).pairs).toEqual([]);
  });

  it('reads them in the order they were written, not in the order they sort', async () => {
    // The same paragraphs rearranged are not the same text. The chunker is
    // deterministic from the body, so the ordinal is the body's own order, and
    // sorting by anything else here would make these two one item.
    await written({
      slug: 'u3',
      title: 'Rearranged',
      chunks: ['Alpha comes first.', 'Beta comes second.'],
      createdAt: at(1),
    });
    await written({
      slug: 'u4',
      title: 'REARRANGED',
      chunks: ['Beta comes second.', 'Alpha comes first.'],
      createdAt: at(2),
    });

    expect((await gardening.duplicateTexts(here, gardener, 10)).pairs).toEqual([]);
  });

  it('leaves a pair the hash rule already has', async () => {
    // Identical content hashes are the other rule's finding, and two rules
    // filing one supersession would be one proposal and one conflict.
    await written({
      slug: 'v1',
      title: 'The same thing',
      chunks: ['One body.'],
      createdAt: at(1),
      contentHash: 'sha256:identical',
    });
    await written({
      slug: 'v2',
      title: 'The same thing',
      chunks: ['One body.'],
      createdAt: at(2),
      contentHash: 'sha256:identical',
    });

    const scan = await gardening.duplicateTexts(here, gardener, 10);
    expect(scan.duplicates).toBe(0);
    expect(scan.pairs).toEqual([]);
  });

  it('leaves two headings over one piece of text alone', async () => {
    // The body folds together and the titles are nothing like each other. A
    // person may well have meant to assert the same text under two headings,
    // and the gardener is not the one to decide otherwise.
    await written({
      slug: 'w1',
      title: 'How we authenticate',
      chunks: ['A six-digit email code.'],
      createdAt: at(1),
    });
    await written({
      slug: 'w2',
      title: 'Deployment runbook for the staging cluster',
      chunks: ['A six-digit email code.'],
      createdAt: at(2),
    });

    expect((await gardening.duplicateTexts(here, gardener, 10)).pairs).toEqual([]);
  });

  it('ignores an index built from a revision the item has moved past', async () => {
    const stale = await written({
      slug: 'x1',
      title: 'Stale index',
      chunks: ['What it used to say.'],
      createdAt: at(1),
    });
    await written({
      slug: 'x2',
      title: 'Stale Index',
      chunks: ['What it used to say.'],
      createdAt: at(2),
      indexRevisionId: stale.revisionId,
    });

    // The second item's chunks name another item's revision, so they are not
    // what it currently asserts. Indexed text the item has moved past is text
    // nobody should be proposed a supersession over.
    const scan = await gardening.duplicateTexts(here, gardener, 10);
    expect(scan.pairs).toEqual([]);
    // And it was not counted as read, which is how an installation waiting for
    // `knoverge db reindex` is visible on the screen rather than hidden.
    expect(scan.examined).toBe(1);
  });

  it('ignores an item with no index at all', async () => {
    await written({
      slug: 'y1',
      title: 'Indexed',
      chunks: ['A body.'],
      createdAt: at(1),
    });
    await item({
      slug: 'y2',
      title: 'Indexed',
      contentHash: 'sha256:y2',
      createdAt: at(2),
      workspace: here,
    });

    const scan = await gardening.duplicateTexts(here, gardener, 10);
    expect(scan.pairs).toEqual([]);
    expect(scan.examined).toBe(1);
  });

  it('leaves out an item a reviewer is already holding, in the query', async () => {
    const keep = await written({
      slug: 'z1',
      title: 'Held',
      chunks: ['A body somebody is reading.'],
      createdAt: at(1),
    });
    await written({
      slug: 'z2',
      title: 'HELD',
      chunks: ['a body somebody is reading.'],
      createdAt: at(2),
    });
    await uow.run((tx) =>
      proposals.insert(tx, {
        id: newId('prop') as ProposalId,
        workspaceId: here,
        proposalType: 'knowledge_supersede',
        targetItemId: keep.itemId,
        targetCategoryId: null,
        status: 'pending',
        proposedByActorId: gardener,
        baseRevisionId: null,
        baseContentHash: null,
        proposedPayload: {},
        reason: null,
        confidence: null,
        acknowledgedDuplicateIds: [],
        syncSessionId: null,
        policyDecision: 'require_review',
        policyRuleId: null,
        createdAt: at(1),
        resolvedAt: null,
        resolvedByActorId: null,
        resolutionNote: null,
        resultRevisionIds: [],
      }),
    );

    // Excluded in the query rather than from the result: the answered items
    // are the oldest, a cap takes the oldest first, and a filter afterwards
    // would starve a capped run (ADR 0042).
    const scan = await gardening.duplicateTexts(here, gardener, 10);
    expect(scan.duplicates).toBe(0);
    expect(scan.pairs).toEqual([]);
  });

  it('counts the candidates there are, and returns the oldest of them', async () => {
    for (const [index, hour] of [1, 2, 3, 4].entries()) {
      await written({
        slug: `cap${index}a`,
        title: `Capped number ${index}`,
        chunks: [`Body number ${index}.`],
        createdAt: at(hour),
      });
      await written({
        slug: `cap${index}b`,
        title: `Capped Number ${index}`,
        chunks: [`body number ${index}.`],
        createdAt: at(hour + 10),
      });
    }

    const scan = await gardening.duplicateTexts(here, gardener, 2);
    // What a rule has to be able to report: more than it may file.
    expect(scan.duplicates).toBe(4);
    expect(scan.pairs).toHaveLength(2);
    // Oldest survivor first, so a capped run files the oldest mess rather
    // than an arbitrary slice.
    expect(scan.pairs.map((pair) => pair.survivor.title)).toEqual([
      'Capped number 0',
      'Capped number 1',
    ]);
  });

  it('is asked of one workspace and answers about one', async () => {
    const elsewhere = await emptyWorkspace();
    await written({
      slug: 'cross1',
      title: 'Shared text',
      chunks: ['The same body in two workspaces.'],
      createdAt: at(1),
    });
    const other = await item({
      slug: 'cross2',
      title: 'Shared Text',
      contentHash: 'sha256:cross2',
      createdAt: at(2),
      workspace: elsewhere,
    });
    await uow.run((tx) =>
      search.upsert(tx, {
        knowledgeItemId: other.itemId,
        workspaceId: elsewhere,
        revisionId: other.revisionId,
        language: 'en',
        title: 'Shared Text',
        chunks: [{ ordinal: 0, text: 'The same body in two workspaces.' }],
        updatedAt: at(2),
      }),
    );

    expect((await gardening.duplicateTexts(here, gardener, 10)).pairs).toEqual([]);
  });
});
