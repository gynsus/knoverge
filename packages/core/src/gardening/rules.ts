import type { GardeningRuleName, KnowledgeItemId, RevisionId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import type { DuplicateTextPair, GardeningRepository } from './repository.ts';
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
  subjectType: 'source_reference' | 'attachment';
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

/** English, because the reason is English and a reviewer reads it. */
function plural(items: number): string {
  return items === 1 ? '1 knowledge item' : `${items} knowledge items`;
}
