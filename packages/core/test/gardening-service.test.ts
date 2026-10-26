import type {
  ActorId,
  CategoryId,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import {
  DomainError,
  danglingAliasRule,
  emptyCategoryRule,
  EMPTY_CATEGORY_GRACE_DAYS,
  GARDENER_CLIENT,
  GardeningService,
  duplicateContentHashRule,
  duplicateTextRule,
  fold,
  orphanAttachmentRule,
  orphanSourceRule,
  staleInstructionRule,
  STALE_INSTRUCTION_DAYS,
  weakProvenanceRule,
  type ActorContext,
  type GardeningFinding,
  type SupersedeFinding,
  type GardeningRepository,
  type GardeningRule,
  type GardeningRunRecord,
  type GardeningSettingsRecord,
  type ProposeSupersedeInput,
  type StaleInstructionWindow,
  type Tx,
  type UnitOfWork,
} from '../src/index.ts';

const WORKSPACE = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as WorkspaceId;
const SYSTEM_ACTOR = 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as ActorId;

/** The gardener, as the service builds it. */
const GARDENER: ActorContext = {
  workspaceId: WORKSPACE,
  actorId: SYSTEM_ACTOR,
  actorType: 'system',
  requestId: 'gardening-grun_test',
  client: GARDENER_CLIENT,
};

/** No transaction: the repositories below are variables. */
const uow: UnitOfWork = {
  run: async <T>(fn: (tx: Tx) => Promise<T>) => fn(undefined as unknown as Tx),
  runExclusive: async <T>(_key: string, fn: (tx: Tx) => Promise<T>) =>
    fn(undefined as unknown as Tx),
  withWorkspaceLock: async <T>(_workspaceId: string, fn: () => Promise<T>) => fn(),
};

function defaults(overrides: Partial<GardeningSettingsRecord> = {}): GardeningSettingsRecord {
  return {
    workspaceId: WORKSPACE,
    enabled: false,
    intervalHours: 24,
    maxFindingsPerRun: 50,
    maxFindingsPerRule: 20,
    lastRunAt: null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** The settings and the runs, in memory. */
function repository(initial = defaults()): GardeningRepository & {
  row: () => GardeningSettingsRecord;
  recorded: () => GardeningRunRecord[];
} {
  let row = initial;
  const runs: GardeningRunRecord[] = [];
  return {
    row: () => row,
    recorded: () => runs,
    settings: async () => row,
    save: async (_tx, _workspaceId, patch, at) => {
      row = { ...row, ...patch, updatedAt: at };
    },
    insertRun: async (_tx, run) => {
      runs.push({ ...run, rules: [...run.rules] });
    },
    finishRun: async (_tx, run) => {
      const index = runs.findIndex((candidate) => candidate.id === run.id);
      runs[index] = { ...run, rules: [...run.rules] };
    },
    runs: async () => [...runs].reverse(),
    due: async () => (row.enabled ? [WORKSPACE] : []),
    // The rules here are fakes, so nothing reaches this. The query it stands
    // for is tested against a real database, which is the only place the
    // exclusion it does in SQL can be tested at all.
    duplicateContentHashes: async () => {
      throw new Error('a fake rule does not scan');
    },
    duplicateTexts: async () => {
      throw new Error('a fake rule does not scan');
    },
    orphanSources: async () => {
      throw new Error('a fake rule does not scan');
    },
    orphanAttachments: async () => {
      throw new Error('a fake rule does not scan');
    },
    weakProvenance: async () => {
      throw new Error('a fake rule does not scan');
    },
    staleInstructions: async () => {
      throw new Error('a fake rule does not scan');
    },
    emptyCategories: async () => {
      throw new Error('a fake rule does not scan');
    },
    danglingAliases: async () => {
      throw new Error('a fake rule does not scan');
    },
  };
}

const actors = {
  findSystemActor: async (workspaceId: WorkspaceId) => ({
    id: SYSTEM_ACTOR,
    workspaceId,
    type: 'system' as const,
    displayName: 'System',
    userId: null,
    agentId: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    disabledAt: null,
  }),
};

/** A filing service that remembers what it was handed, and can refuse. */
function filing(options?: { fail?: DomainError | Error; failOnce?: DomainError }) {
  const filed: { actor: ActorContext; input: ProposeSupersedeInput }[] = [];
  let once = options?.failOnce;
  return {
    filed,
    fileSupersedeFinding: async (actor: ActorContext, input: ProposeSupersedeInput) => {
      if (once !== undefined) {
        const error = once;
        once = undefined;
        throw error;
      }
      if (options?.fail) throw options.fail;
      filed.push({ actor, input });
      return {} as never;
    },
  };
}

/** A rule that reports what a test tells it to. */
function rule(options: {
  examined: number;
  found: number;
  pairs: number;
  name?: 'duplicate_content_hash' | 'duplicate_text';
}): GardeningRule & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    name: options.name ?? 'duplicate_content_hash',
    produces: 'proposals',
    scan: async (_actor, max) => {
      asked.push(max);
      return {
        examined: options.examined,
        found: options.found,
        findings: Array.from({ length: Math.min(options.pairs, max) }, (_, index) => ({
          kind: 'supersede' as const,
          rule: 'duplicate_content_hash' as const,
          oldItemId: `kn_old${index}` as KnowledgeItemId,
          oldBaseRevisionId: `rev_old${index}` as RevisionId,
          oldBaseContentHash: `sha256:${index}`,
          newItemId: `kn_new${index}` as KnowledgeItemId,
          newBaseRevisionId: `rev_new${index}` as RevisionId,
          newBaseContentHash: `sha256:${index}`,
          reason: `gardening rule duplicate_content_hash: pair ${index}`,
        })),
      };
    },
  };
}

/**
 * The supersede findings of a scan, which is what a proposal rule returns.
 *
 * A finding is a proposal or a notice now (ADR 0043), so a test that reads
 * `oldItemId` says which it expected rather than reaching through the union.
 */
function superseding(findings: readonly GardeningFinding[]): SupersedeFinding[] {
  return findings.map((finding) => {
    expect(finding.kind).toBe('supersede');
    return finding as SupersedeFinding;
  });
}

function service(options: {
  gardening: GardeningRepository;
  filing: ReturnType<typeof filing>;
  rules: readonly GardeningRule[];
}) {
  return new GardeningService({
    uow,
    gardening: options.gardening,
    actors,
    filing: options.filing,
    rules: options.rules,
  });
}

describe('a gardening run', () => {
  it('files every finding as the workspace system actor, named as the gardener', async () => {
    const gardening = repository();
    const filer = filing();
    const run = await service({
      gardening,
      filing: filer,
      rules: [rule({ examined: 9, found: 2, pairs: 2 })],
    }).run(WORKSPACE, 'requested');

    expect(run.findingsFiled).toBe(2);
    expect(filer.filed).toHaveLength(2);
    for (const { actor } of filer.filed) {
      expect(actor.actorId).toBe(SYSTEM_ACTOR);
      expect(actor.actorType).toBe('system');
      // What tells a gardening proposal from an operator's command-line write,
      // since both are the system actor (ADR 0042).
      expect(actor.client).toBe(GARDENER_CLIENT);
      // Every proposal of a run carries the run, so it can be read as one.
      expect(actor.requestId).toBe(`gardening-${run.id}`);
    }
  });

  it('asks for a supersession in which the survivor is the item it was given', async () => {
    const gardening = repository();
    const filer = filing();
    await service({
      gardening,
      filing: filer,
      rules: [rule({ examined: 2, found: 1, pairs: 1 })],
    }).run(WORKSPACE, 'requested');

    const [filed] = filer.filed;
    expect(filed?.input.oldItemId).toBe('kn_old0');
    expect(filed?.input.existingItem?.itemId).toBe('kn_new0');
    // Rule 6 travels with the finding: both ends carry what the scan read.
    expect(filed?.input.oldBaseRevisionId).toBe('rev_old0');
    expect(filed?.input.existingItem?.baseRevisionId).toBe('rev_new0');
    // And the rule that produced it, so a reviewer can disagree with the rule.
    expect(filed?.input.reason).toContain('duplicate_content_hash');
  });

  it('records what the rule read and found, not only what it filed', async () => {
    const gardening = repository();
    const run = await service({
      gardening,
      filing: filing(),
      rules: [rule({ examined: 400, found: 3, pairs: 3 })],
    }).run(WORKSPACE, 'scheduled');

    expect(run.rules).toEqual([
      { rule: 'duplicate_content_hash', examined: 400, found: 3, filed: 3, limited: null },
    ]);
    expect(gardening.recorded()).toHaveLength(1);
    expect(gardening.recorded()[0]?.finishedAt).not.toBeNull();
    expect(gardening.recorded()[0]?.trigger).toBe('scheduled');
  });

  it('stops a rule at its own cap and says that is what stopped it', async () => {
    const gardening = repository(defaults({ maxFindingsPerRule: 2, maxFindingsPerRun: 50 }));
    const filer = filing();
    const noisy = rule({ examined: 100, found: 30, pairs: 30 });
    const run = await service({ gardening, filing: filer, rules: [noisy] }).run(
      WORKSPACE,
      'requested',
    );

    expect(noisy.asked).toEqual([2]);
    expect(filer.filed).toHaveLength(2);
    expect(run.rules[0]).toEqual({
      rule: 'duplicate_content_hash',
      examined: 100,
      found: 30,
      filed: 2,
      limited: 'rule_cap',
    });
    // The rule's cap is not the run's: nothing here says the run was full.
    expect(run.reachedCap).toBe(false);
  });

  it('stops the run at its cap and does not read the rules it cannot file', async () => {
    const gardening = repository(defaults({ maxFindingsPerRun: 2, maxFindingsPerRule: 20 }));
    const first = rule({ examined: 10, found: 5, pairs: 5 });
    const second = rule({ examined: 10, found: 5, pairs: 5 });
    const run = await service({
      gardening,
      filing: filing(),
      rules: [first, second],
    }).run(WORKSPACE, 'scheduled');

    expect(run.findingsFiled).toBe(2);
    expect(run.reachedCap).toBe(true);
    expect(run.rules[0]?.limited).toBe('run_cap');
    // Not scanned at all. Reading a workspace to report findings that cannot be
    // filed is work nobody asked for.
    expect(second.asked).toEqual([]);
    expect(run.rules[1]).toEqual({
      rule: 'duplicate_content_hash',
      examined: 0,
      found: 0,
      filed: 0,
      limited: 'run_cap',
    });
  });

  it('skips a finding the workspace has moved past rather than failing the run', async () => {
    const gardening = repository();
    const filer = filing({
      failOnce: new DomainError('REVISION_CONFLICT', 'the item changed since the scan'),
    });
    const run = await service({
      gardening,
      filing: filer,
      rules: [rule({ examined: 4, found: 2, pairs: 2 })],
    }).run(WORKSPACE, 'requested');

    expect(run.error).toBeNull();
    expect(run.findingsFiled).toBe(1);
    expect(run.rules[0]?.found).toBe(2);
  });

  it('records a rule that threw on the run instead of losing it', async () => {
    const gardening = repository();
    const run = await service({
      gardening,
      filing: filing({ fail: new Error('the database went away') }),
      rules: [rule({ examined: 4, found: 1, pairs: 1 })],
    }).run(WORKSPACE, 'requested');

    expect(run.error).toBe('the database went away');
    expect(run.finishedAt).not.toBeNull();
    expect(gardening.recorded()[0]?.error).toBe('the database went away');
  });

  it('sets the last run even when it failed, so the interval is not retried at once', async () => {
    const gardening = repository(defaults({ enabled: true }));
    await service({
      gardening,
      filing: filing({ fail: new Error('no') }),
      rules: [rule({ examined: 1, found: 1, pairs: 1 })],
    }).run(WORKSPACE, 'scheduled');

    expect(gardening.row().lastRunAt).not.toBeNull();
  });

  it('runs the workspaces the schedule says are due and no others', async () => {
    const off = repository();
    expect(await service({ gardening: off, filing: filing(), rules: [] }).runDue()).toHaveLength(0);

    const on = repository(defaults({ enabled: true }));
    const runs = await service({
      gardening: on,
      filing: filing(),
      rules: [rule({ examined: 2, found: 1, pairs: 1 })],
    }).runDue();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe('scheduled');
  });

  it('reports every rule the installation has, so one that found nothing can be named', async () => {
    const view = await service({
      gardening: repository(),
      filing: filing(),
      rules: [rule({ examined: 0, found: 0, pairs: 0 })],
    }).settings(WORKSPACE);

    expect(view.rules).toEqual(['duplicate_content_hash']);
    expect(view.enabled).toBe(false);
  });
});

describe('the duplicate content hash rule', () => {
  const group = (hash: string, members: { id: string; created: string }[]) => ({
    contentHash: hash,
    members: members.map((member) => ({
      itemId: member.id as KnowledgeItemId,
      revisionId: `rev_${member.id}` as RevisionId,
      contentHash: hash,
      title: `title for ${hash}`,
      createdAt: new Date(member.created),
    })),
  });

  it('keeps the head of each group and proposes the rest as copies', async () => {
    const scan = await duplicateContentHashRule({
      duplicateContentHashes: async () => ({
        examined: 5,
        duplicates: 2,
        groups: [
          group('sha256:a', [
            { id: 'kn_first', created: '2026-01-01T00:00:00Z' },
            { id: 'kn_second', created: '2026-02-01T00:00:00Z' },
            { id: 'kn_third', created: '2026-03-01T00:00:00Z' },
          ]),
        ],
      }),
    }).scan(GARDENER, 10);

    expect(scan.examined).toBe(5);
    expect(scan.found).toBe(2);
    // Three items, two findings, and the oldest survives both.
    expect(superseding(scan.findings).map((finding) => finding.oldItemId)).toEqual([
      'kn_second',
      'kn_third',
    ]);
    expect(new Set(superseding(scan.findings).map((finding) => finding.newItemId))).toEqual(
      new Set(['kn_first']),
    );
  });

  it('never returns more findings than it was allowed, whatever the groups hold', async () => {
    const scan = await duplicateContentHashRule({
      duplicateContentHashes: async () => ({
        examined: 9,
        duplicates: 4,
        groups: [
          group('sha256:a', [
            { id: 'kn_a1', created: '2026-01-01T00:00:00Z' },
            { id: 'kn_a2', created: '2026-02-01T00:00:00Z' },
            { id: 'kn_a3', created: '2026-03-01T00:00:00Z' },
          ]),
          group('sha256:b', [
            { id: 'kn_b1', created: '2026-01-01T00:00:00Z' },
            { id: 'kn_b2', created: '2026-02-01T00:00:00Z' },
          ]),
        ],
      }),
    }).scan(GARDENER, 1);

    expect(scan.findings).toHaveLength(1);
    // And still says how many there are, or a capped run would report that
    // there was nothing more to do.
    expect(scan.found).toBe(4);
  });

  it('names the other item and the hash in the reason it files', async () => {
    const scan = await duplicateContentHashRule({
      duplicateContentHashes: async () => ({
        examined: 2,
        duplicates: 1,
        groups: [
          group('sha256:deadbeef', [
            { id: 'kn_keep', created: '2026-01-01T00:00:00Z' },
            { id: 'kn_copy', created: '2026-02-01T00:00:00Z' },
          ]),
        ],
      }),
    }).scan(GARDENER, 10);

    const [finding] = scan.findings;
    expect(finding?.reason).toContain('duplicate_content_hash');
    expect(finding?.reason).toContain('kn_keep');
    expect(finding?.reason).toContain('sha256:deadbeef');
  });
});

describe('the form two bodies are compared in', () => {
  it('sets aside what typing the same sentence twice changes', () => {
    // Capitalisation, accents, and where the lines broke. The content hash
    // settles the last of those three and neither of the first two, which is
    // the whole reason this rule exists beside that one.
    expect(fold('Passwordless  login\nuses a code.')).toBe(fold('passwordless login uses a code.'));
    expect(fold('Le café est prêt')).toBe(fold('LE CAFE EST PRET'));
    expect(fold('  leading and trailing  ')).toBe('leading and trailing');
  });

  it('keeps what changes the meaning', () => {
    // Punctuation is content, and two bodies a comma apart are two bodies a
    // reviewer would want to see rather than one the gardener merged.
    expect(fold("it's here")).not.toBe(fold('its here'));
    expect(fold('a, b')).not.toBe(fold('a b'));
    expect(fold('one two')).not.toBe(fold('two one'));
  });
});

describe('the duplicate text rule', () => {
  const item = (id: string, title: string, hash: string) => ({
    itemId: id as KnowledgeItemId,
    revisionId: `rev_${id}` as RevisionId,
    contentHash: hash,
    title,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  /** A pair as the query returns it, with the files it stands for. */
  function scanning(
    pairs: { survivor: [string, string]; copy: [string, string] }[],
    bodies: Record<string, string>,
    totals: { examined: number; duplicates: number },
  ) {
    const read: string[] = [];
    const rule = duplicateTextRule(
      {
        duplicateTexts: async () => ({
          examined: totals.examined,
          duplicates: totals.duplicates,
          pairs: pairs.map((pair) => ({
            survivor: item(pair.survivor[0], pair.survivor[1], `sha256:${pair.survivor[0]}`),
            copy: item(pair.copy[0], pair.copy[1], `sha256:${pair.copy[0]}`),
          })),
        }),
      },
      async (_actor, itemId) => {
        read.push(itemId);
        const body = bodies[itemId];
        if (body === undefined) {
          throw new DomainError('NOT_FOUND', 'knowledge item not found');
        }
        return body;
      },
    );
    return { rule, read };
  }

  it('files the copy and keeps the survivor the query chose', async () => {
    const { rule } = scanning(
      [{ survivor: ['kn_keep', 'Auth strategy'], copy: ['kn_copy', 'Auth Strategy'] }],
      { kn_keep: 'A six-digit email code.\n', kn_copy: 'a  six-digit email  code.' },
      { examined: 12, duplicates: 1 },
    );
    const scan = await rule.scan(GARDENER, 10);

    expect(scan.examined).toBe(12);
    expect(scan.found).toBe(1);
    const [finding] = superseding(scan.findings);
    expect(finding?.oldItemId).toBe('kn_copy');
    expect(finding?.newItemId).toBe('kn_keep');
    expect(finding?.rule).toBe('duplicate_text');
    // Rule 6 travels with it: both ends carry what the scan read.
    expect(finding?.oldBaseRevisionId).toBe('rev_kn_copy');
    expect(finding?.newBaseContentHash).toBe('sha256:kn_keep');
    // And the reason names the rule and the survivor, so a reviewer can
    // disagree with the rule rather than with this finding.
    expect(finding?.reason).toContain('duplicate_text');
    expect(finding?.reason).toContain('kn_keep');
    expect(finding?.reason).toContain('Auth strategy');
  });

  it('drops a pair the files do not confirm, because an index is not authority', async () => {
    // The candidates came from the lexical index, which is a projection
    // (rule 8). Here the two files do not in fact say the same thing, and
    // nothing is filed about them.
    //
    // One body extends the other rather than contradicting it, which is the
    // shape that tells equality from any of the near-enough tests: a file that
    // begins with what the other says is not a file that says it.
    const { rule, read } = scanning(
      [{ survivor: ['kn_keep', 'Auth strategy'], copy: ['kn_copy', 'Auth Strategy'] }],
      {
        kn_keep: 'A six-digit email code.',
        kn_copy: 'A six-digit email code. Google OAuth is supported too.',
      },
      { examined: 12, duplicates: 1 },
    );
    const scan = await rule.scan(GARDENER, 10);

    expect(scan.findings).toEqual([]);
    expect(scan.found).toBe(0);
    expect(read).toEqual(['kn_copy', 'kn_keep']);
  });

  it('drops a pair whose item has gone, and reports the rest', async () => {
    // Between the scan and the read. A race rather than a fault: the next run
    // looks again, and the other pair is still worth filing.
    const { rule } = scanning(
      [
        { survivor: ['kn_keep', 'The first'], copy: ['kn_gone', 'The First'] },
        { survivor: ['kn_a', 'The second'], copy: ['kn_b', 'The Second'] },
      ],
      { kn_keep: 'One body.', kn_a: 'Another body.', kn_b: 'another  body.' },
      { examined: 12, duplicates: 2 },
    );
    const scan = await rule.scan(GARDENER, 10);

    expect(superseding(scan.findings).map((finding) => finding.oldItemId)).toEqual(['kn_b']);
    expect(scan.found).toBe(1);
  });

  it('lets a file the repository does not hold reach the run', async () => {
    // Not NOT_FOUND: the database says the item exists and the repository does
    // not have the file. That is the corruption the architecture calls
    // unrepairable, and it belongs on the run record rather than swallowed as
    // a pair that did not confirm.
    const rule = duplicateTextRule(
      {
        duplicateTexts: async () => ({
          examined: 2,
          duplicates: 1,
          pairs: [
            { survivor: item('kn_keep', 'A', 'sha256:a'), copy: item('kn_copy', 'A', 'sha256:b') },
          ],
        }),
      },
      async () => {
        throw new DomainError('INTERNAL_ERROR', 'the repository does not contain the file');
      },
    );

    await expect(rule.scan(GARDENER, 10)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('counts the candidates it never looked at as findings there are to file', async () => {
    // The window was full, so what lies beyond it is unread rather than ruled
    // out. A rule that reported only the confirmed ones would tell a capped
    // run there was nothing more to do.
    const { rule } = scanning(
      [{ survivor: ['kn_keep', 'The first'], copy: ['kn_copy', 'The First'] }],
      { kn_keep: 'One body.', kn_copy: 'one  body.' },
      { examined: 40, duplicates: 7 },
    );
    const scan = await rule.scan(GARDENER, 1);

    expect(scan.findings).toHaveLength(1);
    expect(scan.found).toBe(7);
  });
});

describe('a rule whose findings name no write', () => {
  const sources = (found: number, rows: { id: string; type: string; label: string | null }[]) => ({
    orphanSources: async () => ({
      examined: 120,
      found,
      sources: rows.map((row) => ({
        sourceReferenceId: row.id,
        sourceType: row.type,
        label: row.label,
        createdAt: new Date('2026-03-04T05:06:07Z'),
      })),
    }),
  });

  it('files a notice, and names the rule, the kind and what it rests on', async () => {
    const scan = await orphanSourceRule(
      sources(1, [{ id: 'src_one', type: 'web_url', label: 'https://example.test/a' }]),
    ).scan(GARDENER, 10);

    expect(scan.examined).toBe(120);
    const [finding] = scan.findings;
    expect(finding?.kind).toBe('notice');
    expect(finding).toMatchObject({
      rule: 'orphan_source',
      subjectType: 'source_reference',
      subjectId: 'src_one',
    });
    expect(finding?.reason).toContain('orphan_source');
    expect(finding?.reason).toContain('web_url');
    expect(finding?.reason).toContain('https://example.test/a');
    // When it was recorded, because a row written and never attached is a thing
    // that happened at a moment somebody may be able to place.
    expect(finding?.reason).toContain('2026-03-04T05:06:07');
  });

  it('says nothing in the brackets for a source that identifies itself with nothing', async () => {
    // A person having said something is its own occurrence and carries neither
    // a URI nor an external record. An empty pair of brackets would be a field
    // the reader has to decide is empty rather than absent.
    const scan = await orphanSourceRule(
      sources(1, [{ id: 'src_said', type: 'human_input', label: null }]),
    ).scan(GARDENER, 10);

    expect(scan.findings[0]?.reason).not.toContain('(');
  });

  it('counts an attachment in items rather than in rows', async () => {
    const one = await orphanAttachmentRule({
      orphanAttachments: async () => ({
        examined: 31,
        found: 1,
        attachments: [
          { attachmentId: 'att_one', filename: 'budget.xlsx', sizeBytes: 40_960, deletedItems: 1 },
        ],
      }),
    }).scan(GARDENER, 10);
    expect(one.findings[0]?.reason).toContain('1 knowledge item that has been deleted');

    const many = await orphanAttachmentRule({
      orphanAttachments: async () => ({
        examined: 31,
        found: 1,
        attachments: [
          { attachmentId: 'att_two', filename: 'notes.pdf', sizeBytes: 12, deletedItems: 3 },
        ],
      }),
    }).scan(GARDENER, 10);
    expect(many.findings[0]?.reason).toContain('3 knowledge items that have been deleted');
    expect(many.findings[0]).toMatchObject({ subjectType: 'attachment', subjectId: 'att_two' });
  });

  it('declares what it produces, so a rule that found nothing still has a kind', () => {
    expect(orphanSourceRule(sources(0, [])).produces).toBe('notices');
    expect(orphanAttachmentRule({ orphanAttachments: async () => notFound }).produces).toBe(
      'notices',
    );
  });

  const notFound = { examined: 0, found: 0, attachments: [] };
});

/** A rule that reports notices rather than proposals, as a test tells it to. */
function noticing(options: { found: number; notices: number }): GardeningRule & {
  asked: number[];
} {
  const asked: number[] = [];
  return {
    asked,
    name: 'orphan_source',
    produces: 'notices',
    scan: async (_actor, max) => {
      asked.push(max);
      return {
        examined: 7,
        found: options.found,
        findings: Array.from({ length: Math.min(options.notices, max) }, (_, index) => ({
          kind: 'notice' as const,
          rule: 'orphan_source' as const,
          subjectType: 'source_reference' as const,
          subjectId: `src_${index}`,
          reason: `gardening rule orphan_source: row ${index}`,
        })),
      };
    },
  };
}

describe('a run that both files and notices', () => {
  it('records the notices on the run and nothing in the review queue', async () => {
    const gardening = repository();
    const filer = filing();
    const run = await service({
      gardening,
      filing: filer,
      rules: [noticing({ found: 2, notices: 2 })],
    }).run(WORKSPACE, 'requested');

    expect(run.notices.map((notice) => notice.subjectId)).toEqual(['src_0', 'src_1']);
    expect(run.notices[0]?.rule).toBe('orphan_source');
    // Nothing was proposed, and `findings_filed` is what the run left in the
    // queue: a notice is not in it.
    expect(filer.filed).toEqual([]);
    expect(run.findingsFiled).toBe(0);
    // The rule still says it got two down, because from the screen's side that
    // is the same question.
    expect(run.rules[0]).toMatchObject({ examined: 7, found: 2, filed: 2, limited: null });
  });

  it('is still asked once the run cap is full, because the cap protects the queue', async () => {
    // The whole point of the distinction (ADR 0043): an operator who has just
    // hit the cap on duplicates still wants to know about the file nothing
    // rests on.
    const gardening = repository(defaults({ maxFindingsPerRun: 1, maxFindingsPerRule: 1 }));
    const filer = filing();
    const noticer = noticing({ found: 1, notices: 1 });
    const run = await service({
      gardening,
      filing: filer,
      rules: [rule({ examined: 4, found: 3, pairs: 3 }), noticer],
    }).run(WORKSPACE, 'requested');

    expect(run.findingsFiled).toBe(1);
    expect(run.reachedCap).toBe(true);
    // Scanned rather than skipped, and it was asked for its own cap and not
    // for what the run had left.
    expect(noticer.asked).toEqual([1]);
    expect(run.notices).toHaveLength(1);
    expect(run.rules[1]).toMatchObject({ rule: 'orphan_source', filed: 1, limited: null });
  });

  it('holds a noisy notice rule to its own cap, and says which cap that was', async () => {
    // The run cap is deliberately the smaller of the two here. A notice rule
    // that read it would take one notice and report `run_cap`; this one takes
    // its own five and reports `rule_cap`, because the run cap counts proposals
    // and a rule that blamed it would be blaming a cap it never met.
    const gardening = repository(defaults({ maxFindingsPerRun: 1, maxFindingsPerRule: 5 }));
    const run = await service({
      gardening,
      filing: filing(),
      rules: [noticing({ found: 9, notices: 9 })],
    }).run(WORKSPACE, 'requested');

    expect(run.notices).toHaveLength(5);
    expect(run.rules[0]?.limited).toBe('rule_cap');
    expect(run.reachedCap).toBe(false);
    expect(run.findingsFiled).toBe(0);
  });
});

describe('the items that name no source', () => {
  const workspace = (examined: number, cited: number, uncited: string[] = []) => ({
    weakProvenance: async () => ({
      examined,
      cited,
      items: uncited.map((title, index) => ({
        itemId: `kn_uncited${index}` as KnowledgeItemId,
        title,
        type: 'fact',
        createdAt: new Date('2026-02-03T04:05:06Z'),
      })),
    }),
  });

  it('says nothing in a workspace that does not cite its sources', async () => {
    // Every item would be a finding, which is a rule arguing with a decision
    // somebody has already made — and in numbers that would bury the runs that
    // matter.
    const scan = await weakProvenanceRule(workspace(100, 40, ['A claim'])).scan(GARDENER, 10);
    expect(scan.found).toBe(0);
    expect(scan.findings).toEqual([]);
    // Read all the same: "read 100, found 0" is the answer somebody wants, and
    // it is not the same answer as a rule that never ran.
    expect(scan.examined).toBe(100);
  });

  it('says nothing where exactly half of it cites, because mostly is more than half', async () => {
    expect((await weakProvenanceRule(workspace(10, 5, ['A claim'])).scan(GARDENER, 10)).found).toBe(
      0,
    );
  });

  it('says nothing about a workspace too small to have a habit', async () => {
    // Eight of nine items citing a source is a share and not a practice. A new
    // workspace would otherwise be told off for its ninth item on the strength
    // of its first eight.
    const scan = await weakProvenanceRule(workspace(9, 8, ['A claim'])).scan(GARDENER, 10);
    expect(scan.found).toBe(0);
    expect(scan.findings).toEqual([]);
    expect(scan.examined).toBe(9);
  });

  it('names the item, its type and the habit it stands against', async () => {
    const scan = await weakProvenanceRule(workspace(50, 47, ['Rate limits'])).scan(GARDENER, 10);

    // Every uncited item there is, not the three in the window: a capped run
    // has to be able to say there is more of this than it listed.
    expect(scan.found).toBe(3);
    const [finding] = scan.findings;
    expect(finding).toMatchObject({
      kind: 'notice',
      rule: 'weak_provenance',
      subjectType: 'knowledge_item',
      subjectId: 'kn_uncited0',
    });
    expect(finding?.reason).toContain('weak_provenance');
    expect(finding?.reason).toContain('fact');
    expect(finding?.reason).toContain('Rate limits');
    // The comparison, because that is what makes this worth saying at all.
    expect(finding?.reason).toContain('47 of the 50');
  });

  it('declares what it produces, so a rule that found nothing still has a kind', () => {
    expect(weakProvenanceRule(workspace(0, 0)).produces).toBe('notices');
  });
});

describe('the standing orders that have run out', () => {
  const NOW = new Date('2026-10-12T00:00:00Z');
  const clock = { now: () => NOW };

  /** The rows a test hands the rule, and the window the rule asked for. */
  function instructions(
    found: number,
    rows: { title: string; validUntil?: Date | null; revisedAt: Date }[],
  ) {
    const asked: StaleInstructionWindow[] = [];
    return {
      asked,
      examined: 12,
      staleInstructions: async (
        _workspaceId: WorkspaceId,
        window: StaleInstructionWindow,
        _max: number,
      ) => {
        asked.push(window);
        return {
          examined: 12,
          found,
          instructions: rows.map((row, index) => ({
            itemId: `kn_order${index}` as KnowledgeItemId,
            title: row.title,
            validUntil: row.validUntil ?? null,
            revisedAt: row.revisedAt,
          })),
        };
      },
    };
  }

  it('asks for the instructions that ran out by now, or were untouched for a year', async () => {
    const repository = instructions(0, []);
    await staleInstructionRule(repository, clock).scan(GARDENER, 10);

    const [window] = repository.asked;
    expect(window?.now).toEqual(NOW);
    // The clock is the service's, not the database's: how long is long enough
    // is a domain decision, and a query that asked for `now()` could not be
    // tested at a moment of its own choosing.
    expect(window?.untouchedBefore).toEqual(
      new Date(NOW.getTime() - STALE_INSTRUCTION_DAYS * 24 * 60 * 60 * 1000),
    );
  });

  it('says the date an instruction gave itself, when that is what passed', async () => {
    const scan = await staleInstructionRule(
      instructions(1, [
        {
          title: 'Freeze releases',
          validUntil: new Date('2026-01-02T03:04:05Z'),
          revisedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ]),
      clock,
    ).scan(GARDENER, 10);

    expect(scan.examined).toBe(12);
    const [finding] = scan.findings;
    expect(finding).toMatchObject({
      kind: 'notice',
      rule: 'stale_instruction',
      subjectType: 'knowledge_item',
      subjectId: 'kn_order0',
    });
    expect(finding?.reason).toContain('Freeze releases');
    expect(finding?.reason).toContain('stopped being valid on 2026-01-02T03:04:05');
    // And not the other clause: this one was changed five weeks ago.
    expect(finding?.reason).not.toContain('has not been changed');
    // Why it matters that it is still active, which is the whole finding.
    expect(finding?.reason).toContain('still told to follow it');
  });

  it('says how long it has been, when nobody has touched it', async () => {
    const scan = await staleInstructionRule(
      instructions(1, [
        { title: 'Deploy on Fridays', revisedAt: new Date('2024-05-06T07:08:09Z') },
      ]),
      clock,
    ).scan(GARDENER, 10);

    const reason = scan.findings[0]?.reason;
    expect(reason).toContain('has not been changed since 2024-05-06T07:08:09');
    expect(reason).toContain('more than 365 days');
    expect(reason).not.toContain('stopped being valid');
  });

  it('says both where both are true, because that is two facts', async () => {
    const scan = await staleInstructionRule(
      instructions(1, [
        {
          title: 'Ask before deploying',
          validUntil: new Date('2025-01-01T00:00:00Z'),
          revisedAt: new Date('2023-02-03T00:00:00Z'),
        },
      ]),
      clock,
    ).scan(GARDENER, 10);

    const reason = scan.findings[0]?.reason;
    expect(reason).toContain('stopped being valid on 2025-01-01');
    expect(reason).toContain('and has not been changed since 2023-02-03');
  });

  it('drops a row whose dates say nothing, and does not call that a cap', async () => {
    // A row the query should not have returned. The reason has to name what it
    // rests on, so a rule that cannot say why has not found anything — and the
    // count it reports must not make the run claim a cap stopped it.
    const scan = await staleInstructionRule(
      instructions(1, [
        {
          title: 'Still current',
          validUntil: new Date('2027-01-01T00:00:00Z'),
          revisedAt: new Date('2026-10-01T00:00:00Z'),
        },
      ]),
      clock,
    ).scan(GARDENER, 10);

    expect(scan.findings).toEqual([]);
    expect(scan.found).toBe(0);
  });

  it('counts the rows it never looked at as findings there are to report', async () => {
    const scan = await staleInstructionRule(
      instructions(9, [{ title: 'One of nine', revisedAt: new Date('2020-01-01T00:00:00Z') }]),
      clock,
    ).scan(GARDENER, 1);

    // One described and eight unread, so the run can say there is more.
    expect(scan.found).toBe(9);
    expect(scan.findings).toHaveLength(1);
  });

  it('declares what it produces, so a rule that found nothing still has a kind', () => {
    expect(staleInstructionRule(instructions(0, []), clock).produces).toBe('notices');
  });
});

describe('the categories nothing is filed in', () => {
  const NOW = new Date('2026-10-12T00:00:00Z');
  const clock = { now: () => NOW };

  /** The rows a test hands the rule, and the cutoff the rule asked for. */
  function taxonomy(
    found: number,
    rows: { path: string; name: string; createdAt: Date }[],
    examined = 14,
  ) {
    const asked: Date[] = [];
    return {
      asked,
      emptyCategories: async (_workspaceId: WorkspaceId, createdBefore: Date, _max: number) => {
        asked.push(createdBefore);
        return {
          examined,
          found,
          categories: rows.map((row, index) => ({
            categoryId: `cat_empty${index}` as CategoryId,
            path: row.path,
            name: row.name,
            createdAt: row.createdAt,
          })),
        };
      },
    };
  }

  it('asks only about the categories that have been empty for a month', async () => {
    const repository = taxonomy(0, []);
    await emptyCategoryRule(repository, clock).scan(GARDENER, 10);

    // The grace period is the rule's judgement, not the query's: a taxonomy is
    // often laid out before the knowledge arrives, and the clock is the
    // service's so it can be tested at a moment of its own choosing.
    //
    // The date written out rather than computed from the constant, which would
    // make this agree with whatever the constant said. A month is the decision,
    // and changing it should fail a test rather than only itself.
    expect(repository.asked).toEqual([new Date('2026-09-12T00:00:00Z')]);
    expect(EMPTY_CATEGORY_GRACE_DAYS).toBe(30);
  });

  it('names the category, where it sits and when it was made', async () => {
    const scan = await emptyCategoryRule(
      taxonomy(1, [
        {
          path: 'projects/pixel-brisbane/retired',
          name: 'Retired',
          createdAt: new Date('2026-01-02T03:04:05Z'),
        },
      ]),
      clock,
    ).scan(GARDENER, 10);

    expect(scan.examined).toBe(14);
    const [finding] = scan.findings;
    expect(finding).toMatchObject({
      kind: 'notice',
      rule: 'empty_category',
      subjectType: 'category',
      subjectId: 'cat_empty0',
    });
    // The path, because that is what a person recognises a category by, and
    // the date, because a month-old branch and a two-year-old one are
    // different findings.
    expect(finding?.reason).toContain('projects/pixel-brisbane/retired');
    expect(finding?.reason).toContain('Retired');
    expect(finding?.reason).toContain('2026-01-02T03:04:05');
    expect(finding?.reason).toContain('no category under it');
  });

  it('reports every empty category there is, not the ones in the window', async () => {
    const scan = await emptyCategoryRule(
      taxonomy(9, [{ path: 'one', name: 'One', createdAt: new Date('2020-01-01T00:00:00Z') }]),
      clock,
    ).scan(GARDENER, 1);

    // A capped run has to be able to say there is more of this than it listed.
    expect(scan.found).toBe(9);
    expect(scan.findings).toHaveLength(1);
  });

  it('reports what it read even where it found nothing', async () => {
    const scan = await emptyCategoryRule(taxonomy(0, [], 31), clock).scan(GARDENER, 10);
    // "Read 31, found 0" is the answer somebody wants, and it is not the same
    // answer as a rule that never ran.
    expect(scan).toEqual({ examined: 31, found: 0, findings: [] });
  });

  it('declares what it produces, so a rule that found nothing still has a kind', () => {
    expect(emptyCategoryRule(taxonomy(0, []), clock).produces).toBe('notices');
  });
});

describe('the names kept for a category that is closed', () => {
  function aliases(
    found: number,
    rows: { alias: string; path: string; status: string }[],
    examined = 6,
  ) {
    return {
      danglingAliases: async () => ({
        examined,
        found,
        aliases: rows.map((row, index) => ({
          aliasId: `alias_${index}`,
          alias: row.alias,
          categoryId: `cat_closed${index}` as CategoryId,
          path: row.path,
          status: row.status,
          createdAt: new Date('2026-02-03T04:05:06Z'),
        })),
      }),
    };
  }

  it('names the alias, the category it answers for and what that category is', async () => {
    const scan = await danglingAliasRule(
      aliases(1, [
        { alias: 'technical architecture', path: 'projects/old/architecture', status: 'archived' },
      ]),
    ).scan(GARDENER, 10);

    expect(scan.examined).toBe(6);
    const [finding] = scan.findings;
    expect(finding).toMatchObject({
      kind: 'notice',
      rule: 'dangling_alias',
      // The alias and not the category: two names left on one category are two
      // findings, and one notice about the category would read as one.
      subjectType: 'category_alias',
      subjectId: 'alias_0',
    });
    expect(finding?.reason).toContain('technical architecture');
    expect(finding?.reason).toContain('projects/old/architecture');
    expect(finding?.reason).toContain('archived');
    // Why it is worth saying at all: the name is unique across the workspace,
    // so it is refused to whatever category wants it next.
    expect(finding?.reason).toContain('no other category may take it');
  });

  it('is one finding per name, where a category kept several', async () => {
    const scan = await danglingAliasRule(
      aliases(2, [
        { alias: 'old name', path: 'projects/old', status: 'merged' },
        { alias: 'older name', path: 'projects/old', status: 'merged' },
      ]),
    ).scan(GARDENER, 10);

    const subjects = scan.findings.flatMap((finding) =>
      finding.kind === 'notice' ? [finding.subjectId] : [],
    );
    expect(subjects).toEqual(['alias_0', 'alias_1']);
  });

  it('reports every one there is, not the ones in the window', async () => {
    const scan = await danglingAliasRule(
      aliases(4, [{ alias: 'one of four', path: 'projects/old', status: 'archived' }]),
    ).scan(GARDENER, 1);

    expect(scan.found).toBe(4);
    expect(scan.findings).toHaveLength(1);
  });

  it('declares what it produces, so a rule that found nothing still has a kind', () => {
    expect(danglingAliasRule(aliases(0, [])).produces).toBe('notices');
  });
});
