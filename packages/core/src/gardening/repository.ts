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

/**
 * One thing a rule saw that names no write (ADR 0043).
 *
 * Recorded on the run rather than filed as a proposal, because there is nothing
 * for a reviewer to approve, and a review queue item nobody can approve is one
 * that can never be cleared.
 */
export interface GardeningNoticeRecord {
  rule: GardeningRuleName;
  subjectType: 'source_reference' | 'attachment' | 'knowledge_item';
  subjectId: string;
  reason: string;
}

export interface GardeningRunRecord {
  id: string;
  workspaceId: WorkspaceId;
  trigger: 'scheduled' | 'requested';
  startedAt: Date;
  /** Null while it runs, and afterwards for a run a restart interrupted. */
  finishedAt: Date | null;
  /** Proposals left in the review queue. A notice is not one of them. */
  findingsFiled: number;
  reachedCap: boolean;
  /** One line, never a body. */
  error: string | null;
  rules: GardeningRuleResultRecord[];
  notices: GardeningNoticeRecord[];
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

/** A source reference nothing ever rested on, and what it says it is. */
export interface OrphanSource {
  sourceReferenceId: string;
  sourceType: string;
  /** The URI, or the external system and key, or nothing at all. */
  label: string | null;
  createdAt: Date;
}

export interface OrphanSourceScan {
  /** Source references in the workspace, which is what the rule read. */
  examined: number;
  /** How many of them nothing cites, which may be more than `sources` holds. */
  found: number;
  sources: OrphanSource[];
}

/** An attachment kept for knowledge that has been deleted. */
export interface OrphanAttachment {
  attachmentId: string;
  filename: string;
  sizeBytes: number;
  /** How many items were made from it. All of them are deleted. */
  deletedItems: number;
}

export interface OrphanAttachmentScan {
  /** Attachments in the workspace, which is what the rule read. */
  examined: number;
  found: number;
  attachments: OrphanAttachment[];
}

/**
 * An item whose current revision names nothing it rests on.
 *
 * The type comes with it because what a missing source means depends on it: a
 * `decision` somebody made is its own evidence, and a `fact` that cites
 * nothing is a claim with no way to check it.
 */
export interface UncitedItem {
  itemId: KnowledgeItemId;
  title: string;
  type: string;
  createdAt: Date;
}

export interface WeakProvenanceScan {
  /** Active items with a current revision, which is what the rule read. */
  examined: number;
  /**
   * How many of them cite a source.
   *
   * The rule weighs one number against the other: an item citing nothing is
   * only worth saying in a workspace that mostly cites. The repository returns
   * both and judges neither — what counts as a habit is a domain decision, and
   * it belongs where it can be read without a database.
   */
  cited: number;
  /** The uncited ones, oldest first, at most `max`. */
  items: UncitedItem[];
}

/** An instruction whose claim has run out, and what says it has. */
export interface StaleInstruction {
  itemId: KnowledgeItemId;
  title: string;
  /** When it said it would stop being valid, where it said so. */
  validUntil: Date | null;
  /** When the revision the item currently points at was written. */
  revisedAt: Date;
}

export interface StaleInstructionScan {
  /** Active instruction items, which is what the rule read. */
  examined: number;
  found: number;
  instructions: StaleInstruction[];
}

/** The two dates the stale-instruction query compares against. */
export interface StaleInstructionWindow {
  /** Now: an item whose `valid_until` is before this has run out. */
  now: Date;
  /** An item whose current revision is older than this is untouched. */
  untouchedBefore: Date;
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
  /**
   * Source references no revision cites at all.
   *
   * Not "cited only by an older revision", which is the ordinary state of
   * every edited item's history, and not "cited only by a deleted item", which
   * is the history of knowledge somebody removed on purpose. Nothing rested on
   * these, ever: a row written and never attached. In a healthy installation
   * there are none, and a rule that reliably finds nothing is still worth
   * having — on the screen, "found nothing" and "never ran" are different
   * answers.
   *
   * No gardener actor and no exclusion of answered items: a notice is not a
   * proposal, so there is nothing anybody could have already said about it.
   */
  orphanSources(workspaceId: WorkspaceId, max: number): Promise<OrphanSourceScan>;
  /**
   * Attachments every one of whose knowledge items has been deleted.
   *
   * Bytes kept for knowledge that is gone — ADR 0039's own wording. A file
   * whose item was superseded is not one of these: superseded knowledge is
   * still knowledge, and the file is still what it rested on. Nor is a file
   * nothing was ever made from, which is either waiting to be read or one this
   * installation cannot read, and both of those the files screen already says.
   */
  orphanAttachments(workspaceId: WorkspaceId, max: number): Promise<OrphanAttachmentScan>;
  /**
   * Active items whose current revision cites no source, and how many do.
   *
   * Both numbers, because the finding is comparative: an item that rests on
   * nothing it names is unremarkable in a workspace where nothing does, and is
   * worth saying in one where the habit is to cite. What counts as a habit is
   * the rule's judgement and not this query's.
   *
   * The current revision rather than any of them: an item whose first revision
   * cited a page and whose current one dropped it asserts the thing without the
   * page now, and the history is where the page went.
   *
   * No gardener actor and no exclusion of answered items: a notice is not a
   * proposal, so there is nothing anybody could have already said about it.
   */
  weakProvenance(workspaceId: WorkspaceId, max: number): Promise<WeakProvenanceScan>;
  /**
   * Active instructions whose claim has run out, by either of the two ways it
   * can.
   *
   * `valid_until` is the item having said when it would stop, and the date
   * having passed. Untouched is nobody having confirmed it for long enough that
   * it may no longer be how things are done. Both dates are the caller's,
   * because how long is long enough is a domain decision and a query that asked
   * the database for `now()` could not be tested at a moment of its own
   * choosing.
   *
   * Instructions only, not every type: `fact` and `decision` items record what
   * was true and what was decided, and both stay true of the moment they
   * describe. An instruction is a standing order, and a standing order nobody
   * has confirmed in a year is the thing worth asking about.
   */
  staleInstructions(
    workspaceId: WorkspaceId,
    window: StaleInstructionWindow,
    max: number,
  ): Promise<StaleInstructionScan>;
}
