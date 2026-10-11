import type {
  ActorId,
  GardeningRuleName,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/** Whether a workspace tidies itself, and how much it may file (ADR 0042). */
export interface GardeningSettingsRecord {
  workspaceId: WorkspaceId;
  enabled: boolean;
  intervalHours: number;
  maxFindingsPerRun: number;
  maxFindingsPerRule: number;
  lastRunAt: Date | null;
  updatedAt: Date;
}

/** Why a rule filed less than it found, or did not run at all. */
export type GardeningRuleLimit = 'run_cap' | 'rule_cap';

/** One rule's share of a run. */
export interface GardeningRuleResultRecord {
  rule: GardeningRuleName;
  /** How much the rule read, in whatever that rule counts. */
  examined: number;
  /** How many findings it has, which may be more than it was allowed to file. */
  found: number;
  filed: number;
  limited: GardeningRuleLimit | null;
}

export interface GardeningRunRecord {
  id: string;
  workspaceId: WorkspaceId;
  trigger: 'scheduled' | 'requested';
  startedAt: Date;
  /** Null while it runs, and afterwards for a run a restart interrupted. */
  finishedAt: Date | null;
  findingsFiled: number;
  reachedCap: boolean;
  /** One line, never a body. */
  error: string | null;
  rules: GardeningRuleResultRecord[];
}

/** What a run may change about the settings: when it last ran, and nothing else. */
export interface GardeningSettingsPatch {
  enabled?: boolean;
  intervalHours?: number;
  maxFindingsPerRun?: number;
  maxFindingsPerRule?: number;
  lastRunAt?: Date;
}

/** One active item inside a group that shares a content hash. */
export interface DuplicateHashMember {
  itemId: KnowledgeItemId;
  revisionId: RevisionId;
  contentHash: string;
  title: string;
  createdAt: Date;
}

/** Items that assert the same thing twice, and how much was read to find them. */
export interface DuplicateHashGroup {
  contentHash: string;
  /** Oldest first, so the survivor is the head and the rest are the copies. */
  members: DuplicateHashMember[];
}

export interface DuplicateHashScan {
  /** Active items read, which is the whole workspace. */
  examined: number;
  /** Items that would be superseded if every group were filed: sum(size - 1). */
  duplicates: number;
  /** At most `maxGroups`, oldest group first. */
  groups: DuplicateHashGroup[];
}

export interface GardeningRepository {
  /**
   * This workspace's settings, or the defaults where it has no row.
   *
   * A workspace with no row is a workspace nobody has configured, which is
   * gardening off. Returning the defaults rather than null means neither
   * workspace creation nor import has to remember to insert one.
   */
  settings(workspaceId: WorkspaceId): Promise<GardeningSettingsRecord>;
  /** Upsert: the row appears the first time anything is changed. */
  save(tx: Tx, workspaceId: WorkspaceId, patch: GardeningSettingsPatch, at: Date): Promise<void>;
  insertRun(tx: Tx, run: GardeningRunRecord): Promise<void>;
  /** Everything a finished run knows, written once at the end. */
  finishRun(tx: Tx, run: GardeningRunRecord): Promise<void>;
  /** Newest first: a run history is read backwards from now. */
  runs(workspaceId: WorkspaceId, limit: number): Promise<GardeningRunRecord[]>;
  /**
   * Workspaces whose schedule is due, and only those.
   *
   * The interval is a setting rather than a cron expression, so the question is
   * asked of the database and not of a scheduler: enabled, and nothing taken
   * within the interval.
   */
  due(now: Date): Promise<WorkspaceId[]>;
  /**
   * Every hash that more than one fileable active item currently asserts.
   *
   * A gardening query rather than a knowledge one, which is why it lives here:
   * it reads what the workspace asserts and what has already been said about
   * it, and neither repository on its own can answer that.
   *
   * What it leaves out, and why it has to leave it out in the query rather than
   * afterwards: an item with a proposal still waiting, because a reviewer is
   * already looking at it; and an item whose gardening proposal this actor
   * filed was rejected, because a reviewer who said no has answered the rule.
   * Filtering those out of the result instead would starve a capped run — the
   * answered items are the oldest, a cap takes the oldest first, and a
   * workspace with one refused duplicate would file nothing ever again.
   *
   * `groups` is capped by the caller because it is what gets filed;
   * `duplicates` is not, because a rule has to be able to report that it found
   * more than it may file.
   */
  duplicateContentHashes(
    workspaceId: WorkspaceId,
    gardenerActorId: ActorId,
    maxGroups: number,
  ): Promise<DuplicateHashScan>;
}
