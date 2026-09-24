import type { FrontmatterSource, ProposalDetail, ProposalSummary } from '@knoverge/contracts';

/**
 * What a proposal carries, whichever kind it is.
 *
 * Only the fields it actually proposes. An update that changes the body and
 * nothing else carries no title, and showing an empty title box beside it
 * reads as though the proposal were taking the title away.
 */
export interface Content {
  title?: string;
  body?: string;
  type?: string;
  language?: string;
  categories?: string[];
  tags?: string[];
  sources?: FrontmatterSource[];
}

/**
 * A create carries the content at the top level; a supersession carries it
 * under `newItem`, or carries nothing when the replacement is an item the
 * workspace already holds; an update carries only the fields it changes; a
 * delete carries nothing at all.
 */
export function contentOf(proposal: ProposalDetail): Content | null {
  if (proposal.proposal_type === 'knowledge_delete') return null;
  const payload = proposal.proposed_payload as Record<string, unknown> | null;
  if (!payload) return null;
  const source = (
    proposal.proposal_type === 'knowledge_supersede'
      ? (payload['newItem'] as Record<string, unknown> | undefined)
      : payload
  ) as Record<string, unknown> | undefined;
  if (!source) return null;
  const content: Content = {
    ...str(source, 'title'),
    ...str(source, 'body'),
    ...str(source, 'type'),
    ...str(source, 'language'),
    ...list(source, 'categories'),
    ...list(source, 'tags'),
    ...(Array.isArray(source['sources'])
      ? { sources: source['sources'] as FrontmatterSource[] }
      : {}),
  };
  return Object.keys(content).length === 0 ? null : content;
}

/** Items the proposer was shown as possible duplicates and ruled out. */
export function ruledOutDuplicates(proposal: ProposalDetail): string[] {
  const payload = proposal.proposed_payload as Record<string, unknown> | null;
  const ids = payload?.['acknowledgedDuplicateIds'] ?? payload?.['acknowledged_duplicate_ids'];
  return Array.isArray(ids) ? ids.map(String) : [];
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

function str(source: Record<string, unknown>, key: string): Record<string, string> {
  return typeof source[key] === 'string' ? { [key]: source[key] } : {};
}

function list(source: Record<string, unknown>, key: string): Record<string, string[]> {
  return Array.isArray(source[key]) ? { [key]: (source[key] as unknown[]).map(String) } : {};
}
