import type { ActorId, KnowledgeItemId, RevisionId, WorkspaceId } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import {
  DomainError,
  GARDENER_CLIENT,
  GardeningService,
  duplicateContentHashRule,
  duplicateTextRule,
  fold,
  type ActorContext,
  type GardeningRepository,
  type GardeningRule,
  type GardeningRunRecord,
  type GardeningSettingsRecord,
  type ProposeSupersedeInput,
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
    expect(scan.findings.map((finding) => finding.oldItemId)).toEqual(['kn_second', 'kn_third']);
    expect(new Set(scan.findings.map((finding) => finding.newItemId))).toEqual(
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
    const [finding] = scan.findings;
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

    expect(scan.findings.map((finding) => finding.oldItemId)).toEqual(['kn_b']);
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
