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

export type GardeningFinding = SupersedeFinding;

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
