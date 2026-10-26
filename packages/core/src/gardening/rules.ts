import type { GardeningRuleName, KnowledgeItemId, RevisionId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { DuplicateTextPair, GardeningRepository, StaleInstruction } from './repository.ts';
import { fold } from './text.ts';

/**
 * One item should stop being active, because another says exactly the same
 * thing.
 *
 * The only finding kind so far, and the strongest one gardening will ever
 * produce: a supersession is already a reviewed operation with both ends
 * recorded, and nothing here deletes or merges anything (ADR 0039).
 */
export interface SupersedeFinding {
  kind: 'supersede';
  rule: GardeningRuleName;
  /** The copy. It becomes `superseded` if a reviewer agrees. */
  oldItemId: KnowledgeItemId;
  oldBaseRevisionId: RevisionId;
  oldBaseContentHash: string;
  /** The survivor, which the workspace already holds. */
  newItemId: KnowledgeItemId;
  newBaseRevisionId: RevisionId;
  newBaseContentHash: string;
  /**
   * The rule and the rows it read, in one line.
   *
   * English, and not a catalogue key: it goes in the proposal's `reason`, where
   * an agent reading the proposal over MCP sees it too, and where every other
   * reason is whatever the proposer wrote. A finding that cannot name its
   * evidence is an opinion with a queue position (ADR 0039).
   */
  reason: string;
}

/**
 * Something a rule saw that names no write (ADR 0043).
 *
 * The first two rules name one: this item should stop being active because that
 * one says the same thing. Most of the rest name none — a source reference no
 * revision cites is not a write anybody could approve — and a review queue item
 * nobody can approve is one that can never be cleared. So these are recorded on
 * the run and shown there.
 */
export interface NoticeFinding {
  kind: 'notice';
  rule: GardeningRuleName;
  subjectType: 'source_reference' | 'attachment' | 'knowledge_item' | 'category' | 'category_alias';
  subjectId: string;
  /** The rule and what it rested on, in one line, as a proposal's reason is. */
  reason: string;
}

export type GardeningFinding = SupersedeFinding | NoticeFinding;

export interface GardeningScan {
  /** How much the rule read, in whatever it counts. */
  examined: number;
  /** How many findings it has, which may be more than `findings` holds. */
  found: number;
  /** At most the `max` it was asked for. */
  findings: GardeningFinding[];
}

export interface GardeningRule {
  readonly name: GardeningRuleName;
  /**
   * Whether its findings are proposals or notices (ADR 0043).
   *
   * Declared rather than inferred from what comes back, because a rule that
   * found nothing would then have no kind — and the two are capped
   * differently: the run cap exists to keep the review queue readable, and a
   * notice is not in it.
   */
  readonly produces: 'proposals' | 'notices';
  /**
   * Looks, and reports. Nothing is written here.
   *
   * `max` is how many findings the run can still take, so a rule need not
   * assemble more than that — but it still answers with how many it found, or
   * a capped run would report that there was nothing more to do.
   *
   * The actor is passed because what is worth finding depends on what has
   * already been said to this gardener: a rule excludes what a reviewer is
   * holding or has refused, and does it in its own query rather than afterwards.
   */
  scan(actor: ActorContext, max: number): Promise<GardeningScan>;
}

/**
 * Two active items whose current content hash is identical.
 *
 * The content hash covers the title and the body and no metadata, so a match
 * means the same words under the same heading twice. Recategorising or
 * reviewing an item does not change it; this is the `content_hash` half of what
 * reconciliation already does, pointed inward at one workspace (ADR 0039).
 *
 * The oldest member of a group survives. The relations and the sources that
 * exist point at it, its history is the longer one, and the copy is the thing
 * that happened afterwards — usually an agent that wrote without reconciling.
 */
export function duplicateContentHashRule(
  gardening: Pick<GardeningRepository, 'duplicateContentHashes'>,
): GardeningRule {
  return {
    name: 'duplicate_content_hash',
    produces: 'proposals',
    async scan(actor, max) {
      // Groups, not findings: a group of three produces two findings, so asking
      // for `max` groups can never return fewer findings than `max` allows.
      const scan = await gardening.duplicateContentHashes(actor.workspaceId, actor.actorId, max);
      const findings: GardeningFinding[] = [];
      for (const group of scan.groups) {
        const [survivor, ...copies] = group.members;
        if (survivor === undefined) continue;
        for (const copy of copies) {
          if (findings.length >= max) break;
          findings.push({
            kind: 'supersede',
            rule: 'duplicate_content_hash',
            oldItemId: copy.itemId,
            oldBaseRevisionId: copy.revisionId,
            oldBaseContentHash: copy.contentHash,
            newItemId: survivor.itemId,
            newBaseRevisionId: survivor.revisionId,
            newBaseContentHash: survivor.contentHash,
            reason:
              `gardening rule duplicate_content_hash: this item and ${survivor.itemId} ` +
              `("${survivor.title}") have the same content hash ${copy.contentHash}, ` +
              `so they assert the same thing twice. The older of the two is kept.`,
          });
        }
      }
      return { examined: scan.examined, found: scan.duplicates, findings };
    },
  };
}

/**
 * How close two titles have to be before the same body under both is one item.
 *
 * The same number the duplicate screen uses on a write, and for the same
 * reason: trigram similarity, where PostgreSQL's own 0.3 pairs unrelated short
 * titles. It is a looser test than the body's, which is equality, because the
 * body is already carrying the claim — this only decides that the two titles
 * are the same heading rather than two headings over one piece of text, which
 * is a thing somebody may well have meant.
 */
export const TEXT_TITLE_SIMILARITY_THRESHOLD = 0.6;

/**
 * Two active items that say the same thing in the same words, typed
 * differently.
 *
 * What the content-hash rule misses. That hash rests on `normalise`, which
 * settles line endings and blank lines and nothing else, so "Auth strategy"
 * and "Auth Strategy" over one identical body are two items to it. This folds
 * capitalisation, accents and line breaks away as well (`fold`), and asks of
 * the titles only that they be near enough to be the same heading — the body
 * is what carries the claim.
 *
 * It stops at equality. Two bodies that are merely similar are a merge, and
 * ADR 0039 puts a merge in the optional layer, because what two
 * nearly-identical items should become is a draft and a draft is writing.
 *
 * The oldest of the fold group survives, for the reasons the hash rule keeps
 * the oldest: the relations and the sources that exist point at it, its history
 * is the longer one, and the copy is the thing that happened afterwards.
 *
 * `bodies` reads canonical content, because the candidates come from the
 * lexical index and an index is not authority (rule 8). A pair the file does
 * not confirm is dropped rather than filed.
 */
export function duplicateTextRule(
  gardening: Pick<GardeningRepository, 'duplicateTexts'>,
  bodies: (actor: ActorContext, itemId: KnowledgeItemId) => Promise<string>,
): GardeningRule {
  return {
    name: 'duplicate_text',
    produces: 'proposals',
    async scan(actor, max) {
      const scan = await gardening.duplicateTexts(actor.workspaceId, actor.actorId, max);
      const findings: GardeningFinding[] = [];
      for (const pair of scan.pairs) {
        if (!(await saysTheSame(actor, pair, bodies))) continue;
        findings.push({
          kind: 'supersede',
          rule: 'duplicate_text',
          oldItemId: pair.copy.itemId,
          oldBaseRevisionId: pair.copy.revisionId,
          oldBaseContentHash: pair.copy.contentHash,
          newItemId: pair.survivor.itemId,
          newBaseRevisionId: pair.survivor.revisionId,
          newBaseContentHash: pair.survivor.contentHash,
          reason:
            `gardening rule duplicate_text: this item and ${pair.survivor.itemId} ` +
            `("${pair.survivor.title}") hold the same words in the same order, differing ` +
            `only in capitalisation, accents or where the lines break, and their titles ` +
            `are near enough to be one heading. The older of the two is kept.`,
        });
      }
      // What was confirmed, plus what was never looked at. The candidates
      // beyond the window are unread rather than ruled out, and a rule that
      // reported only the confirmed ones would tell a capped run there was
      // nothing more to do.
      const unexamined = Math.max(0, scan.duplicates - scan.pairs.length);
      return { examined: scan.examined, found: findings.length + unexamined, findings };
    },
  };
}

/**
 * Whether the files say what the index said they said.
 *
 * `NOT_FOUND` is the item having gone between the scan and this read, which is
 * a race and not a fault: the pair is dropped and the next run looks again.
 * Anything else — a file the repository does not hold — is the corruption the
 * architecture calls unrepairable, and it belongs on the run rather than
 * swallowed here.
 */
async function saysTheSame(
  actor: ActorContext,
  pair: DuplicateTextPair,
  bodies: (actor: ActorContext, itemId: KnowledgeItemId) => Promise<string>,
): Promise<boolean> {
  try {
    const [copy, survivor] = await Promise.all([
      bodies(actor, pair.copy.itemId),
      bodies(actor, pair.survivor.itemId),
    ]);
    return fold(copy) === fold(survivor);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

/**
 * Source references no revision cites at all.
 *
 * Nothing ever rested on them: a row written and never attached. Not a source
 * cited only by an older revision — that is the ordinary state of every edited
 * item's history — and not one cited only by a deleted item, which is the
 * history of knowledge somebody removed on purpose.
 *
 * Attachment sources are left to `orphan_attachment`, which can say something
 * about the bytes rather than about the row that points at them. Two notices
 * about one file would be two readings of the same fact.
 *
 * In a healthy installation this finds nothing, every time. That is the point:
 * from the screen, a rule that found nothing and a rule that never ran are
 * different answers, and this one is cheap enough to ask every run.
 */
export function orphanSourceRule(
  gardening: Pick<GardeningRepository, 'orphanSources'>,
): GardeningRule {
  return {
    name: 'orphan_source',
    produces: 'notices',
    async scan(actor, max) {
      const scan = await gardening.orphanSources(actor.workspaceId, max);
      return {
        examined: scan.examined,
        found: scan.found,
        findings: scan.sources.map((source) => ({
          kind: 'notice' as const,
          rule: 'orphan_source' as const,
          subjectType: 'source_reference' as const,
          subjectId: source.sourceReferenceId,
          reason:
            `gardening rule orphan_source: this ${source.sourceType} source was recorded ` +
            `on ${source.createdAt.toISOString()}${source.label === null ? '' : ` (${source.label})`} ` +
            `and no revision cites it, so nothing in this workspace rests on it.`,
        })),
      };
    },
  };
}

/**
 * Attachments every one of whose knowledge items has been deleted.
 *
 * Bytes kept for knowledge that is gone. A file whose item was superseded is
 * not one of these — superseded knowledge is still knowledge, and the file is
 * still what it rested on — and nor is a file nothing was ever made from, which
 * is either waiting to be read or one this installation cannot read, and the
 * files screen says both of those itself.
 *
 * There is no button that deletes the bytes, so this tells an operator
 * something they can act on only through the command line. That is worse than a
 * button and better than not knowing (ADR 0043).
 */
export function orphanAttachmentRule(
  gardening: Pick<GardeningRepository, 'orphanAttachments'>,
): GardeningRule {
  return {
    name: 'orphan_attachment',
    produces: 'notices',
    async scan(actor, max) {
      const scan = await gardening.orphanAttachments(actor.workspaceId, max);
      return {
        examined: scan.examined,
        found: scan.found,
        findings: scan.attachments.map((attachment) => ({
          kind: 'notice' as const,
          rule: 'orphan_attachment' as const,
          subjectType: 'attachment' as const,
          subjectId: attachment.attachmentId,
          reason:
            `gardening rule orphan_attachment: ${attachment.filename} is ` +
            `${attachment.sizeBytes} bytes kept for ${plural(attachment.deletedItems)} that ` +
            `${attachment.deletedItems === 1 ? 'has' : 'have'} been deleted, so nothing this ` +
            `workspace asserts rests on the file.`,
        })),
      };
    },
  };
}

/**
 * How much of a workspace has to cite its sources before citing none is worth
 * saying.
 *
 * More than half of it. The finding is comparative and not absolute: an
 * installation nobody records provenance in is one where every item would be a
 * notice, which is a rule reporting a decision somebody has already made.
 * Where most items name what they rest on, the few that name nothing are the
 * ones somebody wrote in a hurry.
 */
export const WEAK_PROVENANCE_HABIT_SHARE = 0.5;

/**
 * How many items a workspace needs before its habit is a habit.
 *
 * Two items out of three is a share and not a practice. A new workspace would
 * otherwise be told off for its third item on the strength of its first two,
 * which is the opposite of what this rule is for.
 */
export const WEAK_PROVENANCE_MINIMUM_ITEMS = 10;

/**
 * Items that rest on nothing they name, where the workspace mostly names
 * something.
 *
 * Provenance is the whole point of the ledger (rule 3), but rule 3 is about
 * who wrote a revision and this is about what the revision rested on — which
 * nothing can require, because somebody may simply know a thing. So it is a
 * notice: there is no write to propose. What the item should cite is not
 * something the installation can know, and an item citing nothing is not wrong
 * in the way a duplicate is wrong.
 *
 * It says nothing at all in a workspace that does not cite sources. A rule that
 * reported every item in such a workspace would be reporting a decision
 * somebody has already made, every run, and in numbers that would bury the
 * runs that matter.
 */
export function weakProvenanceRule(
  gardening: Pick<GardeningRepository, 'weakProvenance'>,
): GardeningRule {
  return {
    name: 'weak_provenance',
    produces: 'notices',
    async scan(actor, max) {
      const scan = await gardening.weakProvenance(actor.workspaceId, max);
      // `examined` is reported whether or not anything is said about it: a
      // workspace that does not cite sources has still been read, and "read
      // 400, found 0" is the answer somebody wants.
      if (
        scan.examined < WEAK_PROVENANCE_MINIMUM_ITEMS ||
        scan.cited <= scan.examined * WEAK_PROVENANCE_HABIT_SHARE
      ) {
        return { examined: scan.examined, found: 0, findings: [] };
      }
      return {
        examined: scan.examined,
        // Every uncited item there is, not the window: a capped run has to be
        // able to report that there is more of this than it listed.
        found: scan.examined - scan.cited,
        findings: scan.items.map((item) => ({
          kind: 'notice' as const,
          rule: 'weak_provenance' as const,
          subjectType: 'knowledge_item' as const,
          subjectId: item.itemId,
          reason:
            `gardening rule weak_provenance: this ${item.type}, "${item.title}", names no ` +
            `source at its current revision, where ${scan.cited} of the ${scan.examined} ` +
            `active items in this workspace name one.`,
        })),
      };
    },
  };
}

/**
 * How long an instruction nobody has touched stays an instruction.
 *
 * A year. An instruction is written to last — a quarter-old one is an ordinary
 * instruction, not a neglected one — and a year is long enough that the person
 * who wrote it has had the chance to say otherwise and did not. Shorter would
 * make this rule a reminder to re-save files.
 */
export const STALE_INSTRUCTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Standing orders that have run out: past the date they gave themselves, or
 * untouched long enough to be in doubt.
 *
 * Instructions only. A `fact` records what was true and a `decision` what was
 * decided, and both stay true of the moment they describe; an instruction is a
 * standing order, and an agent reading this workspace will follow it today.
 *
 * A notice rather than a proposal, although a write is imaginable here in a way
 * it is not for an orphan row: somebody could delete it, or re-date it, or
 * replace it. Which of those is right is exactly what the installation cannot
 * know, and gardening's one proposal kind is a supersession by an item the
 * workspace already holds (ADR 0039). A rule that guessed would be filing its
 * guess into the review queue.
 */
export function staleInstructionRule(
  gardening: Pick<GardeningRepository, 'staleInstructions'>,
  clock: Clock = systemClock,
): GardeningRule {
  return {
    name: 'stale_instruction',
    produces: 'notices',
    async scan(actor, max) {
      const now = clock.now();
      const untouchedBefore = new Date(now.getTime() - STALE_INSTRUCTION_DAYS * DAY_MS);
      const scan = await gardening.staleInstructions(
        actor.workspaceId,
        { now, untouchedBefore },
        max,
      );
      const findings: GardeningFinding[] = [];
      for (const instruction of scan.instructions) {
        const why = whyStale(instruction, now, untouchedBefore);
        // A row whose dates say nothing is dropped rather than described: the
        // reason has to name what it rests on, and a rule that cannot say why
        // has not found anything (ADR 0039).
        if (why === null) continue;
        findings.push({
          kind: 'notice',
          rule: 'stale_instruction',
          subjectType: 'knowledge_item',
          subjectId: instruction.itemId,
          reason:
            `gardening rule stale_instruction: "${instruction.title}" is active and ${why}, ` +
            `so an agent reading this workspace is still told to follow it.`,
        });
      }
      // What was described, plus what was never looked at — the same arithmetic
      // as the text rule, and for the same reason: a dropped row must not make
      // a run report that a cap stopped it.
      const unexamined = Math.max(0, scan.found - scan.instructions.length);
      return { examined: scan.examined, found: findings.length + unexamined, findings };
    },
  };
}

/**
 * Why this instruction is in doubt, in the words of the dates themselves.
 *
 * Both clauses where both apply: an instruction that ran out two years ago and
 * has not been touched since is two facts, and a reader deciding what to do
 * with it wants both. Null where neither does, which is a row the query should
 * not have returned.
 */
function whyStale(instruction: StaleInstruction, now: Date, untouchedBefore: Date): string | null {
  const clauses: string[] = [];
  if (instruction.validUntil !== null && instruction.validUntil <= now) {
    clauses.push(`stopped being valid on ${instruction.validUntil.toISOString()}`);
  }
  if (instruction.revisedAt < untouchedBefore) {
    clauses.push(
      `has not been changed since ${instruction.revisedAt.toISOString()}, which is more ` +
        `than ${STALE_INSTRUCTION_DAYS} days`,
    );
  }
  return clauses.length === 0 ? null : clauses.join(' and ');
}

/**
 * How long a category may stay empty before its being empty is worth saying.
 *
 * A month. A taxonomy is often built before the knowledge arrives — somebody
 * lays out the branches they expect to fill — and a rule that reported those
 * the next morning would be arguing with the way the screen is meant to be
 * used. A month later, an empty branch is either one nobody needed or one
 * somebody has forgotten.
 */
export const EMPTY_CATEGORY_GRACE_DAYS = 30;

/**
 * Categories nothing is filed in, with nothing under them.
 *
 * The taxonomy is what tells an agent where knowledge belongs (rule 13 reads
 * it by id, and an agent reads it by path), so a branch that holds nothing is
 * a place an agent may file something because it exists rather than because it
 * fits. ADR 0025 already decided what may become of one: a category nothing
 * has ever depended on may be deleted outright, and one that was used is
 * archived instead.
 *
 * Which of those it should be is why this is a notice. Deleting is right for a
 * category created by mistake and wrong for one a project has finished with,
 * and nothing recorded tells the two apart. The screen refuses a delete that
 * would break something and names what, so the reader has what they need the
 * moment they arrive.
 */
export function emptyCategoryRule(
  gardening: Pick<GardeningRepository, 'emptyCategories'>,
  clock: Clock = systemClock,
): GardeningRule {
  return {
    name: 'empty_category',
    produces: 'notices',
    async scan(actor, max) {
      const createdBefore = new Date(clock.now().getTime() - EMPTY_CATEGORY_GRACE_DAYS * DAY_MS);
      const scan = await gardening.emptyCategories(actor.workspaceId, createdBefore, max);
      return {
        examined: scan.examined,
        found: scan.found,
        findings: scan.categories.map((category) => ({
          kind: 'notice' as const,
          rule: 'empty_category' as const,
          subjectType: 'category' as const,
          subjectId: category.categoryId,
          reason:
            `gardening rule empty_category: ${category.path} ("${category.name}") was made on ` +
            `${category.createdAt.toISOString()} and holds no knowledge items, with no category ` +
            `under it, so nothing in this workspace is filed there.`,
        })),
      };
    },
  };
}

/**
 * Aliases kept for a category that is no longer active.
 *
 * An alias is a name somebody recorded, and it is unique across the workspace:
 * one left on an archived or merged category keeps a name nothing can be filed
 * under and refuses it to the category that may want it next (CATEGORY_CONFLICT
 * is what a curator sees). A merge carries them over to the survivor on
 * purpose, so these are the ones no merge accounted for.
 *
 * A notice, and the subject is the alias rather than the category: two aliases
 * left on one category are two names, and one notice naming the category would
 * read as one finding. Removing them is an edit of the category, which the
 * reason names so a reader knows where to go.
 */
export function danglingAliasRule(
  gardening: Pick<GardeningRepository, 'danglingAliases'>,
): GardeningRule {
  return {
    name: 'dangling_alias',
    produces: 'notices',
    async scan(actor, max) {
      const scan = await gardening.danglingAliases(actor.workspaceId, max);
      return {
        examined: scan.examined,
        found: scan.found,
        findings: scan.aliases.map((alias) => ({
          kind: 'notice' as const,
          rule: 'dangling_alias' as const,
          subjectType: 'category_alias' as const,
          subjectId: alias.aliasId,
          reason:
            `gardening rule dangling_alias: "${alias.alias}" is an alias of ${alias.path}, ` +
            `which is ${alias.status}, so the name is kept for a category nothing can be filed ` +
            `in and no other category may take it.`,
        })),
      };
    },
  };
}

/** English, because the reason is English and a reviewer reads it. */
function plural(items: number): string {
  return items === 1 ? '1 knowledge item' : `${items} knowledge items`;
}
