import {
  ProposedContent,
  ProposedSupersedePayload,
  type ProposalDetail,
  type ProposalSummary,
} from '@knoverge/contracts';

/**
 * What a proposal carries, whichever kind it is.
 *
 * The payload's own schema rather than a type written out again here: what a
 * proposal can carry is decided once, in the contract, and a reviewer has to see
 * all of it. Reading it by hand is how this screen came to look for two
 * spellings of one field and to show neither a validity window nor a summary's
 * dependencies.
 *
 * Every field is optional because a proposal carries only what it proposes. An
 * update that changes the body and nothing else carries no title, and an empty
 * title box beside it would read as the proposal taking the title away.
 */
export type Content = ProposedContent;

/**
 * A create carries the content at the top level; a supersession carries it
 * under `new_item`, or carries nothing when the replacement is an item the
 * workspace already holds; an update carries only the fields it changes; a
 * delete carries nothing at all.
 */
export function contentOf(proposal: ProposalDetail): Content | null {
  if (proposal.proposal_type === 'knowledge_delete') return null;
  if (proposal.proposal_type === 'knowledge_supersede') {
    const parsed = ProposedSupersedePayload.safeParse(proposal.proposed_payload);
    return present(parsed.success ? parsed.data.new_item : undefined);
  }
  const parsed = ProposedContent.safeParse(proposal.proposed_payload);
  return present(parsed.success ? parsed.data : undefined);
}

/** Nothing to show is null, not an empty object: a redacted payload has none. */
function present(content: Content | undefined): Content | null {
  return content && Object.keys(content).length > 0 ? content : null;
}

/**
 * Items the proposer was shown as possible duplicates and ruled out.
 *
 * From the proposal itself, which is where they are recorded. This read the
 * payload for them until the record started serving them, and so answered "none
 * were ruled out" for every proposal ever made.
 */
export function ruledOutDuplicates(proposal: ProposalSummary): string[] {
  return [...proposal.acknowledged_duplicate_ids];
}

/** Why this proposal is in the queue rather than already applied. */
export type QueueReason = 'conflict' | 'policy' | 'duplicate_ruled_out' | 'no_category' | 'unknown';

/**
 * The reasons this is waiting, most pressing first.
 *
 * Read off the record rather than stored as a sentence: a proposal is here
 * because of what it is, and a reviewer who cannot tell why is deciding
 * without the one fact that frames the decision.
 */
export function queueReasons(proposal: ProposalDetail): QueueReason[] {
  const reasons: QueueReason[] = [];
  if (proposal.status === 'conflict') reasons.push('conflict');
  if (proposal.policy_decision === 'require_review') reasons.push('policy');
  if (ruledOutDuplicates(proposal).length > 0) reasons.push('duplicate_ruled_out');
  const content = contentOf(proposal);
  if (
    proposal.proposal_type === 'knowledge_create' &&
    content !== null &&
    (content.categories?.length ?? 0) === 0
  ) {
    reasons.push('no_category');
  }
  return reasons.length > 0 ? reasons : ['unknown'];
}

/** The segments the counters across the top stand for. */
export type Segment = 'all' | 'conflict' | 'create' | 'change' | 'today';

/**
 * Whether a proposal belongs to a segment.
 *
 * `change` covers updates, replacements and removals together: they are all
 * "this touches something that already exists", which is the question a
 * reviewer is asking when they pick that pile.
 */
export function inSegment(proposal: ProposalSummary, segment: Segment, now: Date): boolean {
  switch (segment) {
    case 'all':
      return true;
    case 'conflict':
      return proposal.status === 'conflict';
    case 'create':
      return proposal.proposal_type === 'knowledge_create';
    case 'change':
      return (
        proposal.proposal_type === 'knowledge_update' ||
        proposal.proposal_type === 'knowledge_supersede' ||
        proposal.proposal_type === 'knowledge_delete'
      );
    case 'today': {
      const at = new Date(proposal.created_at);
      return (
        at.getFullYear() === now.getFullYear() &&
        at.getMonth() === now.getMonth() &&
        at.getDate() === now.getDate()
      );
    }
  }
}
