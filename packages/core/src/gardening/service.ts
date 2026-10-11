import type { ActorId, WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ActorRepository } from '../workspace/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { ProposalService } from '../proposals/service.ts';
import type {
  GardeningRepository,
  GardeningRuleLimit,
  GardeningRuleResultRecord,
  GardeningRunRecord,
  GardeningSettingsRecord,
} from './repository.ts';
import type { GardeningFinding, GardeningRule } from './rules.ts';

/**
 * What the gardener puts in the provenance of everything it files.
 *
 * The actor is the workspace's system actor, which is also the identity the
 * command line acts as; this is what tells the two apart in the ledger and on
 * a proposal (ADR 0042).
 */
export const GARDENER_CLIENT = 'gardener';

/** How many runs the screen reads. A history, not an archive. */
const RUNS_SHOWN = 20;

export interface GardeningServiceOptions {
  uow: UnitOfWork;
  gardening: GardeningRepository;
  /** Read to find the system actor the gardener acts as. */
  actors: Pick<ActorRepository, 'findSystemActor'>;
  /** Only the filing entry point: the gardener has no path that writes. */
  filing: Pick<ProposalService, 'fileSupersedeFinding'>;
  /** Every rule this installation has. */
  rules: readonly GardeningRule[];
  clock?: Clock;
}

export interface GardeningSettingsView extends GardeningSettingsRecord {
  /** Every rule, so the screen can name one that found nothing. */
  rules: string[];
}

export interface SaveGardeningSettingsInput {
  enabled: boolean;
  intervalHours: number;
  maxFindingsPerRun: number;
  maxFindingsPerRule: number;
}

/**
 * The installation reading its own knowledge and filing what it finds.
 *
 * Every finding is a proposal and nothing else (ADR 0039), and the filing path
 * cannot become a write however the workspace is configured (ADR 0042).
 */
export class GardeningService {
  private readonly clock: Clock;

  constructor(private readonly o: GardeningServiceOptions) {
    this.clock = o.clock ?? systemClock;
  }

  async settings(workspaceId: WorkspaceId): Promise<GardeningSettingsView> {
    return this.view(await this.o.gardening.settings(workspaceId));
  }

  async save(
    workspaceId: WorkspaceId,
    input: SaveGardeningSettingsInput,
  ): Promise<GardeningSettingsView> {
    await this.o.uow.run((tx) => this.o.gardening.save(tx, workspaceId, input, this.clock.now()));
    return this.settings(workspaceId);
  }

  async runs(workspaceId: WorkspaceId): Promise<GardeningRunRecord[]> {
    return this.o.gardening.runs(workspaceId, RUNS_SHOWN);
  }

  /**
   * Every workspace whose schedule is due, run one after another.
   *
   * One at a time on purpose: a run files proposals, and two workspaces being
   * tidied at once would only make the log harder to read. There is no hurry
   * here — the schedule is hours.
   */
  async runDue(): Promise<GardeningRunRecord[]> {
    const due = await this.o.gardening.due(this.clock.now());
    const runs: GardeningRunRecord[] = [];
    for (const workspaceId of due) runs.push(await this.run(workspaceId, 'scheduled'));
    return runs;
  }

  /**
   * One run over one workspace.
   *
   * The run row is written before the rules are read and finished afterwards,
   * so a run interrupted by a restart is recognisable as one that never
   * finished rather than missing altogether.
   */
  async run(
    workspaceId: WorkspaceId,
    trigger: 'scheduled' | 'requested',
  ): Promise<GardeningRunRecord> {
    const settings = await this.o.gardening.settings(workspaceId);
    const startedAt = this.clock.now();
    const run: GardeningRunRecord = {
      id: newId('grun'),
      workspaceId,
      trigger,
      startedAt,
      finishedAt: null,
      findingsFiled: 0,
      reachedCap: false,
      error: null,
      rules: [],
    };
    await this.o.uow.run((tx) => this.o.gardening.insertRun(tx, run));
    // Named after the run, so every proposal it files carries the run it came
    // out of, the way an OAuth grant's writes carry the grant.
    const actor = await this.gardener(workspaceId, run.id);

    try {
      for (const rule of this.o.rules) {
        run.rules.push(await this.runRule(rule, actor, settings, run));
      }
    } catch (error) {
      // The run is a record of what happened, so a rule that threw is reported
      // on it rather than lost in a job log. What was filed before the throw
      // stays filed: a proposal is a proposal whatever happened next.
      run.error = oneLine(error);
    }

    const finishedAt = this.clock.now();
    run.finishedAt = finishedAt;
    await this.o.uow.run(async (tx) => {
      await this.o.gardening.finishRun(tx, run);
      // `last_run_at` is what the schedule reads, and it is set whether the run
      // found anything or threw: a run that failed still ran, and an interval
      // that ignored it would retry every minute.
      await this.o.gardening.save(tx, workspaceId, { lastRunAt: finishedAt }, finishedAt);
    });
    return run;
  }

  private async runRule(
    rule: GardeningRule,
    actor: ActorContext,
    settings: GardeningSettingsRecord,
    run: GardeningRunRecord,
  ): Promise<GardeningRuleResultRecord> {
    const runRemaining = settings.maxFindingsPerRun - run.findingsFiled;
    if (runRemaining <= 0) {
      // Not scanned at all, and the result says why. Reading a workspace to
      // report findings that cannot be filed is work nobody asked for.
      run.reachedCap = true;
      return { rule: rule.name, examined: 0, found: 0, filed: 0, limited: 'run_cap' };
    }
    const allowed = Math.min(settings.maxFindingsPerRule, runRemaining);
    // What the rule leaves out — an item a reviewer is holding, or one whose
    // finding they have already refused — it leaves out in its own query. A
    // filter here instead would starve a capped run, because the answered items
    // are the oldest and a cap takes the oldest first (ADR 0042).
    const scan = await rule.scan(actor, allowed);

    let filed = 0;
    let limited: GardeningRuleLimit | null = null;
    for (const finding of scan.findings) {
      if (filed >= allowed) {
        limited = runRemaining <= settings.maxFindingsPerRule ? 'run_cap' : 'rule_cap';
        break;
      }
      if (await this.file(actor, finding)) filed += 1;
    }
    run.findingsFiled += filed;
    // The cap bit if there was more than could be filed, whether or not the
    // loop above reached it: a scan that returned exactly `allowed` findings
    // and knows of more is capped too.
    if (limited === null && scan.found > filed) {
      limited = runRemaining <= settings.maxFindingsPerRule ? 'run_cap' : 'rule_cap';
    }
    if (limited === 'run_cap') run.reachedCap = true;
    return { rule: rule.name, examined: scan.examined, found: scan.found, filed, limited };
  }

  /**
   * One finding, filed. True when it became a proposal.
   *
   * A finding the workspace has moved past is skipped rather than fatal: the
   * scan read a moment that has gone, and the next run reads the one after it.
   */
  private async file(actor: ActorContext, finding: GardeningFinding): Promise<boolean> {
    try {
      await this.o.filing.fileSupersedeFinding(actor, {
        oldItemId: finding.oldItemId,
        oldBaseRevisionId: finding.oldBaseRevisionId,
        oldBaseContentHash: finding.oldBaseContentHash,
        existingItem: {
          itemId: finding.newItemId,
          baseRevisionId: finding.newBaseRevisionId,
          baseContentHash: finding.newBaseContentHash,
        },
        reason: finding.reason,
      });
      return true;
    } catch (error) {
      if (error instanceof DomainError && SKIPPABLE.has(error.code)) return false;
      throw error;
    }
  }

  /** Who the gardener is: the workspace's own system actor, named as such. */
  private async gardener(workspaceId: WorkspaceId, runId: string): Promise<ActorContext> {
    const actor = await this.o.actors.findSystemActor(workspaceId);
    if (actor === null) {
      // Every workspace has one, created with it and unique by partial index.
      // A workspace without one is a workspace this installation did not make.
      throw new DomainError('INTERNAL_ERROR', `workspace ${workspaceId} has no system actor`);
    }
    return {
      workspaceId,
      actorId: actor.id as ActorId,
      actorType: 'system',
      requestId: `gardening-${runId}`,
      client: GARDENER_CLIENT,
    };
  }

  private view(settings: GardeningSettingsRecord): GardeningSettingsView {
    return { ...settings, rules: this.o.rules.map((rule) => rule.name) };
  }
}

/**
 * What a finding is allowed to fail with.
 *
 * `REVISION_CONFLICT` is the workspace having moved on since the scan.
 * `DUPLICATE_SUSPECTED` is the duplicate check refusing the proposal, which for
 * a finding about duplicates is the other half of the product agreeing.
 * `RATE_LIMITED` is the actor's own pending backlog, which is the cap arriving
 * from the other direction.
 */
const SKIPPABLE = new Set(['REVISION_CONFLICT', 'DUPLICATE_SUSPECTED', 'RATE_LIMITED']);

/** One line, because that is the width of the column it goes in. */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, ' ').slice(0, 500);
}
