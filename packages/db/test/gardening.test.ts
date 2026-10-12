import { fileURLToPath } from 'node:url';

import type {
  ActorId,
  ItemType,
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
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  schema,
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
  status?: 'active' | 'superseded' | 'deleted';
  /** What the revision calls it. The slug, where a test does not care. */
  title?: string;
  /** `fact`, where a test does not care which kind of assertion it is. */
  type?: ItemType;
  /** When it says it stops being valid. Null for an item that does not say. */
  validUntil?: Date | null;
  /** When the revision was written, where that is not when the item was. */
  revisedAt?: Date;
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
      type: options.type ?? 'fact',
      status: options.status ?? 'active',
      language: 'en',
      currentRevisionId: null,
      reviewState: 'unreviewed',
      evidenceState: 'none',
      disputed: false,
      validFrom: null,
      validUntil: options.validUntil ?? null,
      observedAt: null,
      sourceSystem: null,
      externalKey: null,
      createdByActorId: (await createActorRepository(handle.db).findSystemActor(workspace))!.id,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      // A deleted item carries when: deletion is logical, and the row is what
      // says so.
      deletedAt: (options.status ?? 'active') === 'deleted' ? options.createdAt : null,
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
      createdAt: options.revisedAt ?? options.createdAt,
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
    notices: [],
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

/**
 * One item in the workspace a test is about, in whatever state.
 *
 * The slug carries the state so two items with the same name in one test do not
 * collide on the unique index.
 */
async function itemHere(
  workspace: WorkspaceId,
  slug: string,
  status: 'active' | 'superseded' | 'deleted' = 'active',
): Promise<{ itemId: KnowledgeItemId; revisionId: RevisionId }> {
  return item({
    slug: slug.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-'),
    contentHash: `sha256:${slug}`,
    createdAt: at(1),
    workspace,
    status,
  });
}

describe('the evidence nothing rests on', () => {
  let here: WorkspaceId;

  beforeEach(async () => {
    here = await emptyWorkspace();
  });

  /** One source reference, and optionally a revision that cites it. */
  async function source(options: {
    slug: string;
    sourceType: string;
    uri?: string | null;
    externalSystem?: string | null;
    externalKey?: string | null;
    attachmentId?: string | null;
    citedBy?: RevisionId;
    createdAt: Date;
  }): Promise<string> {
    const id = newId('src');
    await handle.db.insert(schema.sourceReferences).values({
      id,
      workspaceId: here,
      sourceType: options.sourceType,
      uri: options.uri ?? null,
      externalSystem: options.externalSystem ?? null,
      externalKey: options.externalKey ?? null,
      attachmentId: options.attachmentId ?? null,
      sourceModifiedAt: null,
      sourceContentHash: null,
      confidence: null,
      metadata: {},
      createdAt: options.createdAt,
    });
    if (options.citedBy) {
      await handle.db.insert(schema.revisionSources).values({
        revisionId: options.citedBy,
        sourceReferenceId: id,
        evidenceRole: 'primary',
        position: 0,
      });
    }
    return id;
  }

  it('is the row no revision cites, and not the one an older revision does', async () => {
    const item = await itemHere(here, 's1');
    const orphan = await source({
      slug: 's-orphan',
      sourceType: 'web_url',
      uri: 'https://example.test/nothing',
      createdAt: at(1),
    });
    // Cited by a revision, which is the ordinary state of evidence — including
    // evidence only an older revision cites, because that revision still does.
    await source({
      slug: 's-cited',
      sourceType: 'web_url',
      uri: 'https://example.test/cited',
      citedBy: item.revisionId,
      createdAt: at(2),
    });

    const scan = await gardening.orphanSources(here, 10);
    expect(scan.found).toBe(1);
    expect(scan.sources).toHaveLength(1);
    expect(scan.sources[0]?.sourceReferenceId).toBe(orphan);
    expect(scan.sources[0]?.sourceType).toBe('web_url');
    expect(scan.sources[0]?.label).toBe('https://example.test/nothing');
    // Both of them: this is what the rule looked at, not what it found.
    expect(scan.examined).toBe(2);
  });

  it('leaves an attachment source to the rule that can speak about the file', async () => {
    await source({ slug: 's-att', sourceType: 'attachment', createdAt: at(1) });

    // Two notices about one file would be two readings of the same fact, and
    // only one of them could say how many bytes are being kept.
    const scan = await gardening.orphanSources(here, 10);
    expect(scan.found).toBe(0);
    // And it is not counted as read either, or a workspace full of files would
    // look like one full of unread evidence.
    expect(scan.examined).toBe(0);
  });

  it('names a source by its external record when it has no address', async () => {
    await source({
      slug: 's-ext',
      sourceType: 'external_system',
      externalSystem: 'jira',
      externalKey: 'KNV-7',
      createdAt: at(1),
    });

    expect((await gardening.orphanSources(here, 10)).sources[0]?.label).toBe('jira KNV-7');
  });

  it('names nothing for a source that identifies itself with nothing', async () => {
    // A person having said something is its own occurrence: it carries neither
    // a URI nor an external record, and is not deduplicated against anything.
    await source({ slug: 's-said', sourceType: 'human_input', createdAt: at(1) });

    expect((await gardening.orphanSources(here, 10)).sources[0]?.label).toBeNull();
  });

  it('counts what there is and returns the oldest of it', async () => {
    for (const hour of [3, 1, 2]) {
      await source({
        slug: `s-many-${hour}`,
        sourceType: 'web_url',
        uri: `https://example.test/${hour}`,
        createdAt: at(hour),
      });
    }

    const scan = await gardening.orphanSources(here, 2);
    expect(scan.found).toBe(3);
    expect(scan.sources.map((row) => row.label)).toEqual([
      'https://example.test/1',
      'https://example.test/2',
    ]);
  });
});

describe('the files kept for nothing', () => {
  let here: WorkspaceId;

  beforeEach(async () => {
    here = await emptyWorkspace();
  });

  /** One attachment, and the items made from it, in whatever state. */
  async function file(options: {
    name: string;
    createdAt: Date;
    items: ('active' | 'superseded' | 'deleted')[];
  }): Promise<string> {
    const attachmentId = newId('att');
    const actorId = (await createActorRepository(handle.db).findSystemActor(here))!.id;
    await handle.db.insert(schema.attachments).values({
      id: attachmentId,
      workspaceId: here,
      contentHash: `sha256:${attachmentId}`,
      mediaType: 'application/pdf',
      sizeBytes: 1024,
      filename: options.name,
      originalUri: null,
      extractionState: 'extracted',
      extractionError: null,
      extractionStartedAt: null,
      uploadedByActorId: actorId,
      createdAt: options.createdAt,
    });
    for (const [index, status] of options.items.entries()) {
      const made = await itemHere(here, `${options.name}-${index}`, status);
      const sourceId = newId('src');
      await handle.db.insert(schema.sourceReferences).values({
        id: sourceId,
        workspaceId: here,
        sourceType: 'attachment',
        uri: null,
        externalSystem: null,
        externalKey: null,
        attachmentId,
        sourceModifiedAt: null,
        sourceContentHash: null,
        confidence: null,
        metadata: {},
        createdAt: options.createdAt,
      });
      await handle.db.insert(schema.revisionSources).values({
        revisionId: made.revisionId,
        sourceReferenceId: sourceId,
        evidenceRole: 'primary',
        position: 0,
      });
    }
    return attachmentId;
  }

  it('is the one whose every item is deleted, counted in items', async () => {
    const gone = await file({
      name: 'budget.xlsx',
      createdAt: at(1),
      items: ['deleted', 'deleted'],
    });
    await file({ name: 'live.pdf', createdAt: at(2), items: ['active'] });
    // Superseded knowledge is still knowledge, and the file is still what it
    // rested on.
    await file({ name: 'older.pdf', createdAt: at(3), items: ['superseded'] });
    // And a file nothing was made from is waiting to be read or is one this
    // installation cannot read. The files screen says both of those itself.
    await file({ name: 'unread.pdf', createdAt: at(4), items: [] });

    const scan = await gardening.orphanAttachments(here, 10);
    expect(scan.found).toBe(1);
    expect(scan.attachments).toHaveLength(1);
    expect(scan.attachments[0]).toMatchObject({
      attachmentId: gone,
      filename: 'budget.xlsx',
      sizeBytes: 1024,
      deletedItems: 2,
    });
    // Every attachment in the workspace: this is what it read.
    expect(scan.examined).toBe(4);
  });

  it('is not the one whose items are deleted and one is not', async () => {
    // One live item is enough: the bytes are what that item rests on.
    await file({ name: 'mixed.pdf', createdAt: at(1), items: ['deleted', 'active'] });

    expect((await gardening.orphanAttachments(here, 10)).found).toBe(0);
  });

  it('counts an item once however many of its revisions cite the file', async () => {
    const twice = await file({ name: 'twice.pdf', createdAt: at(1), items: ['deleted'] });
    // A second source row for the same file on the same revision is what a
    // re-read produces, and it is still one item.
    const second = newId('src');
    // The revision that cites *this* file, not whichever row the table happens
    // to return first: `revision_sources` holds every test's rows.
    const [revision] = await handle.db
      .select({ id: schema.revisionSources.revisionId })
      .from(schema.revisionSources)
      .innerJoin(
        schema.sourceReferences,
        eq(schema.sourceReferences.id, schema.revisionSources.sourceReferenceId),
      )
      .where(
        and(
          eq(schema.sourceReferences.workspaceId, here),
          eq(schema.sourceReferences.attachmentId, twice),
        ),
      )
      .limit(1);
    await handle.db.insert(schema.sourceReferences).values({
      id: second,
      workspaceId: here,
      sourceType: 'attachment',
      uri: null,
      externalSystem: null,
      externalKey: null,
      attachmentId: twice,
      sourceModifiedAt: null,
      sourceContentHash: null,
      confidence: null,
      metadata: {},
      createdAt: at(2),
    });
    await handle.db.insert(schema.revisionSources).values({
      revisionId: revision!.id,
      sourceReferenceId: second,
      evidenceRole: 'supporting',
      position: 1,
    });

    expect((await gardening.orphanAttachments(here, 10)).attachments[0]?.deletedItems).toBe(1);
  });

  it('counts what there is and returns the oldest of it', async () => {
    await file({ name: 'third.pdf', createdAt: at(3), items: ['deleted'] });
    await file({ name: 'first.pdf', createdAt: at(1), items: ['deleted'] });
    await file({ name: 'second.pdf', createdAt: at(2), items: ['deleted'] });

    const scan = await gardening.orphanAttachments(here, 2);
    expect(scan.found).toBe(3);
    expect(scan.attachments.map((row) => row.filename)).toEqual(['first.pdf', 'second.pdf']);
  });

  it('is asked of one workspace and answers about one', async () => {
    const elsewhere = here;
    await file({ name: 'theirs.pdf', createdAt: at(1), items: ['deleted'] });
    here = await emptyWorkspace();

    expect((await gardening.orphanAttachments(here, 10)).found).toBe(0);
    expect((await gardening.orphanAttachments(elsewhere, 10)).found).toBe(1);
  });
});

describe('the items that name no source', () => {
  let here: WorkspaceId;

  beforeEach(async () => {
    here = await emptyWorkspace();
  });

  /** One source reference, cited by that revision. */
  async function cite(revisionId: RevisionId, uri: string): Promise<string> {
    const id = newId('src');
    await handle.db.insert(schema.sourceReferences).values({
      id,
      workspaceId: here,
      sourceType: 'web_url',
      uri,
      externalSystem: null,
      externalKey: null,
      attachmentId: null,
      sourceModifiedAt: null,
      sourceContentHash: null,
      confidence: null,
      metadata: {},
      createdAt: at(1),
    });
    await handle.db.insert(schema.revisionSources).values({
      revisionId,
      sourceReferenceId: id,
      evidenceRole: 'primary',
      position: 0,
    });
    return id;
  }

  it('counts what cites and returns what does not, oldest first', async () => {
    const cited = await item({
      slug: 'p-cited',
      contentHash: 'sha256:a',
      createdAt: at(1),
      workspace: here,
    });
    await cite(cited.revisionId, 'https://example.test/a');
    await item({
      slug: 'p-bare-2',
      contentHash: 'sha256:b',
      createdAt: at(2),
      workspace: here,
      title: 'Second',
    });
    await item({
      slug: 'p-bare-3',
      contentHash: 'sha256:c',
      createdAt: at(3),
      workspace: here,
      title: 'Third',
    });

    const scan = await gardening.weakProvenance(here, 10);
    // Both numbers, because the finding is comparative: the rule weighs the
    // items that name nothing against the workspace's habit of naming
    // something, and neither number alone says anything.
    expect(scan.examined).toBe(3);
    expect(scan.cited).toBe(1);
    expect(scan.items.map((row) => row.title)).toEqual(['Second', 'Third']);
    expect(scan.items[0]).toMatchObject({ type: 'fact' });
  });

  it('reads the current revision and not the ones before it', async () => {
    // An item whose first revision cited a page and whose current one dropped
    // it asserts the thing without the page now. The history is where the page
    // went.
    const dropped = await item({
      slug: 'p-dropped',
      contentHash: 'sha256:d',
      createdAt: at(1),
      workspace: here,
      title: 'Dropped its source',
    });
    await cite(dropped.revisionId, 'https://example.test/gone');
    const second = newId('rev') as RevisionId;
    await uow.run(async (tx) => {
      await revisions.insert(tx, {
        id: second,
        knowledgeItemId: dropped.itemId,
        workspaceId: here,
        revisionNumber: 2,
        contentHash: 'sha256:d2',
        frontmatterHash: 'sha256:fm',
        gitCommitHash: 'd'.repeat(40),
        title: 'Dropped its source',
        markdownPath: 'knowledge/_uncategorised/p-dropped.md',
        frontmatter: {} as never,
        changeKind: 'update',
        createdByActorId: (await createActorRepository(handle.db).findSystemActor(here))!.id,
        createdAt: at(2),
        operationId: newId('op'),
        reason: null,
      });
      await knowledge.update(tx, dropped.itemId, { currentRevisionId: second });
    });

    const scan = await gardening.weakProvenance(here, 10);
    expect(scan.cited).toBe(0);
    expect(scan.items.map((row) => row.title)).toEqual(['Dropped its source']);
  });

  it('is about what the workspace asserts, which is its active items', async () => {
    await item({
      slug: 'p-gone',
      contentHash: 'sha256:e',
      createdAt: at(1),
      workspace: here,
      status: 'deleted',
    });
    await item({
      slug: 'p-old',
      contentHash: 'sha256:f',
      createdAt: at(2),
      workspace: here,
      status: 'superseded',
    });

    const scan = await gardening.weakProvenance(here, 10);
    expect(scan.examined).toBe(0);
    expect(scan.items).toEqual([]);
  });

  it('does not count an item between its insert and its first revision', async () => {
    // A write in flight. Counting it would make the workspace's habit depend
    // on a transaction that has not finished.
    await uow.run(async (tx) =>
      knowledge.insert(tx, {
        id: newId('kn') as KnowledgeItemId,
        workspaceId: here,
        slug: 'p-midwrite',
        markdownPath: 'knowledge/_uncategorised/p-midwrite.md',
        type: 'fact',
        status: 'active',
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
        createdByActorId: (await createActorRepository(handle.db).findSystemActor(here))!.id,
        createdAt: at(1),
        updatedAt: at(1),
        deletedAt: null,
      }),
    );

    const scan = await gardening.weakProvenance(here, 10);
    expect(scan.examined).toBe(0);
    expect(scan.items).toEqual([]);
  });

  it('is asked of one workspace and answers about one', async () => {
    const elsewhere = here;
    await item({ slug: 'p-theirs', contentHash: 'sha256:g', createdAt: at(1), workspace: here });
    here = await emptyWorkspace();
    await item({ slug: 'p-ours', contentHash: 'sha256:h', createdAt: at(1), workspace: here });

    expect((await gardening.weakProvenance(here, 10)).examined).toBe(1);
    expect((await gardening.weakProvenance(elsewhere, 10)).examined).toBe(1);
    expect((await gardening.weakProvenance(here, 10)).items[0]?.itemId).not.toBe(
      (await gardening.weakProvenance(elsewhere, 10)).items[0]?.itemId,
    );
  });

  it('returns at most the window it was asked for, and counts past it', async () => {
    for (const hour of [3, 1, 2]) {
      await item({
        slug: `p-many-${hour}`,
        contentHash: `sha256:m${hour}`,
        createdAt: at(hour),
        workspace: here,
        title: `Item ${hour}`,
      });
    }

    const scan = await gardening.weakProvenance(here, 2);
    // How many there are comes from the counts rather than the window: three
    // read, none citing, two listed.
    expect(scan.examined).toBe(3);
    expect(scan.cited).toBe(0);
    expect(scan.items.map((row) => row.title)).toEqual(['Item 1', 'Item 2']);
  });
});

describe('the standing orders that have run out', () => {
  let here: WorkspaceId;
  const NOW = new Date('2026-10-12T00:00:00Z');
  const A_YEAR_AGO = new Date('2025-10-12T00:00:00Z');
  const window = { now: NOW, untouchedBefore: A_YEAR_AGO };

  beforeEach(async () => {
    here = await emptyWorkspace();
  });

  /** One instruction, as of whenever it was last written. */
  const order = (
    slug: string,
    options: {
      validUntil?: Date | null;
      revisedAt: Date;
      status?: 'active' | 'superseded' | 'deleted';
      type?: ItemType;
    },
  ) =>
    item({
      slug,
      contentHash: `sha256:${slug}`,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      workspace: here,
      title: slug,
      type: options.type ?? 'instruction',
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
      revisedAt: options.revisedAt,
    });

  it('is the one past the date it gave itself, and the one nobody has touched', async () => {
    await order('expired', {
      validUntil: new Date('2026-06-01T00:00:00Z'),
      revisedAt: new Date('2026-05-01T00:00:00Z'),
    });
    await order('untouched', { revisedAt: new Date('2024-01-01T00:00:00Z') });
    // Current on both counts: the date is ahead and somebody changed it last
    // month.
    await order('current', {
      validUntil: new Date('2027-01-01T00:00:00Z'),
      revisedAt: new Date('2026-09-01T00:00:00Z'),
    });

    const scan = await gardening.staleInstructions(here, window, 10);
    expect(scan.found).toBe(2);
    expect(scan.instructions.map((row) => row.title).sort()).toEqual(['expired', 'untouched']);
    // Every active instruction, which is what the rule read.
    expect(scan.examined).toBe(3);
  });

  it('is about instructions and not about everything that carries a date', async () => {
    // A fact records what was true and a decision what was decided. Both stay
    // true of the moment they describe; an instruction is what an agent
    // reading this workspace will follow today.
    await order('old-fact', { type: 'fact', revisedAt: new Date('2020-01-01T00:00:00Z') });
    await order('old-decision', { type: 'decision', revisedAt: new Date('2020-01-01T00:00:00Z') });

    const scan = await gardening.staleInstructions(here, window, 10);
    expect(scan.found).toBe(0);
    expect(scan.examined).toBe(0);
  });

  it('is about what the workspace still asserts, which is its active items', async () => {
    await order('deleted-order', {
      status: 'deleted',
      revisedAt: new Date('2020-01-01T00:00:00Z'),
    });
    await order('superseded-order', {
      status: 'superseded',
      revisedAt: new Date('2020-01-01T00:00:00Z'),
    });

    const scan = await gardening.staleInstructions(here, window, 10);
    expect(scan.found).toBe(0);
    expect(scan.examined).toBe(0);
  });

  it('carries both dates, so the rule can say which of them makes it stale', async () => {
    await order('both', {
      validUntil: new Date('2025-01-01T00:00:00Z'),
      revisedAt: new Date('2023-02-03T00:00:00Z'),
    });

    const [row] = (await gardening.staleInstructions(here, window, 10)).instructions;
    expect(row?.validUntil).toEqual(new Date('2025-01-01T00:00:00Z'));
    expect(row?.revisedAt).toEqual(new Date('2023-02-03T00:00:00Z'));
  });

  it('counts what there is and returns the oldest neglect first', async () => {
    await order('middle', { revisedAt: new Date('2024-01-01T00:00:00Z') });
    await order('oldest', { revisedAt: new Date('2021-01-01T00:00:00Z') });
    // Changed last week, and expired five years ago: the older of the two
    // dates is what puts it in the queue, so it sorts by that.
    await order('long-expired', {
      validUntil: new Date('2020-06-01T00:00:00Z'),
      revisedAt: new Date('2026-10-05T00:00:00Z'),
    });

    const scan = await gardening.staleInstructions(here, window, 2);
    expect(scan.found).toBe(3);
    expect(scan.instructions.map((row) => row.title)).toEqual(['long-expired', 'oldest']);
  });

  it('is asked of one workspace and answers about one', async () => {
    const elsewhere = here;
    await order('theirs', { revisedAt: new Date('2020-01-01T00:00:00Z') });
    here = await emptyWorkspace();

    expect((await gardening.staleInstructions(here, window, 10)).found).toBe(0);
    expect((await gardening.staleInstructions(elsewhere, window, 10)).found).toBe(1);
    // What it read is scoped too, or a workspace with no instructions at all
    // would report somebody else's.
    expect((await gardening.staleInstructions(here, window, 10)).examined).toBe(0);
    expect((await gardening.staleInstructions(elsewhere, window, 10)).examined).toBe(1);
  });
});
