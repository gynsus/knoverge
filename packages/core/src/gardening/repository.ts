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

/**
 * One item as a rule found it.
 *
 * The revision and the hash travel with it because rule 6 applies to a finding
 * as much as to a person: what gets filed is a proposal against the state the
 * scan read, and the workspace may have moved on by the time it is filed.
 */
export interface GardeningItem {
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
  members: GardeningItem[];
}

/**
 * Two items that say the same thing in the same words, typed differently.
 *
 * A pair rather than a group: which item survives depends on the title it is
 * compared against, so unlike a hash group these do not partition cleanly. The
 * survivor is the oldest of the fold group and the copy is one of the rest.
 */
export interface DuplicateTextPair {
  /** The one the workspace keeps. */
  survivor: GardeningItem;
  /** The one proposed for supersession. */
  copy: GardeningItem;
}

export interface DuplicateTextScan {
  /** Items whose text the rule could compare, which is what it read. */
  examined: number;
  /** Candidate pairs there are, which may be more than `pairs` holds. */
  duplicates: number;
  /** At most `maxPairs`, oldest survivor first. */
  pairs: DuplicateTextPair[];
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
  /**
   * Pairs of fileable active items whose indexed text folds to the same string
   * and whose titles are near enough to be the same heading.
   *
   * Candidates, not findings. The text it compares is the lexical index, which
   * is a projection and not authority (rule 8): the index is written with the
   * revision it describes and the query only looks at rows that match the
   * item's current revision, but a rule that proposes a supersession has to
   * rest on canonical content, so the caller confirms each pair against the
   * file before filing it.
   *
   * The fold here is the looser of the two on purpose — `lower(unaccent(...))`
   * with whitespace collapsed, which is PostgreSQL's reading of the same idea
   * as `fold` in `text.ts`. Looser means it may offer a pair the caller then
   * rejects; the other way round would hide a duplicate from the rule
   * altogether.
   *
   * What it leaves out, and why it has to leave it out in the query rather than
   * afterwards, is what `duplicateContentHashes` leaves out, for the same
   * reason. It also leaves out a pair whose content hashes match, because that
   * is the other rule's finding and two rules filing one supersession would be
   * one proposal and one conflict.
   */
  duplicateTexts(
    workspaceId: WorkspaceId,
    gardenerActorId: ActorId,
    maxPairs: number,
  ): Promise<DuplicateTextScan>;
}
