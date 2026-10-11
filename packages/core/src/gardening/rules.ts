import type { GardeningRuleName, KnowledgeItemId, RevisionId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import type { GardeningRepository } from './repository.ts';

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
