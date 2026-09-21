import { z } from 'zod';

import { PolicyEffect } from './policy.ts';
import { ActorId, KnowledgeItemId, ProposalId, RevisionId, WorkspaceId } from './ids.ts';
import { CreateKnowledgeRequest } from './knowledge.ts';

export const ProposalType = z.enum([
  'knowledge_create',
  'knowledge_update',
  'knowledge_delete',
  'knowledge_supersede',
  'category_create',
  'category_update',
]);
export type ProposalType = z.infer<typeof ProposalType>;

/**
 * `approved` covers both a reviewer saying yes and a policy rule saying
 * `allow_direct`: the trail reads the same either way, and who resolved it
 * says which it was.
 */
export const ProposalStatus = z.enum([
  'pending',
  'approved',
  'approved_with_edits',
  'rejected',
  'superseded',
  'withdrawn',
  'conflict',
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const ProposalSummary = z.object({
  id: ProposalId,
  workspace_id: WorkspaceId,
  proposal_type: ProposalType,
  status: ProposalStatus,
  target_item_id: KnowledgeItemId.nullable(),
  proposed_by_actor_id: ActorId,
  base_revision_id: RevisionId.nullable(),
  base_content_hash: z.string().nullable(),
  reason: z.string().nullable(),
  confidence: z.number().nullable(),
  /** Whether policy asked for review or let it through. */
  policy_decision: PolicyEffect.exclude(['deny']),
  created_at: z.iso.datetime({ offset: true }),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
  resolved_by_actor_id: ActorId.nullable(),
  resolution_note: z.string().nullable(),
  result_revision_ids: z.array(RevisionId),
});
export type ProposalSummary = z.infer<typeof ProposalSummary>;

/** The summary plus what was actually proposed, which a reviewer has to read. */
export const ProposalDetail = ProposalSummary.extend({
  proposed_payload: z.unknown(),
});
export type ProposalDetail = z.infer<typeof ProposalDetail>;

/**
 * Proposing a new item.
 *
 * The same shape a person writes with, minus the parts a proposer does not
 * decide: whether it is reviewed, and when it takes effect.
 */
export const ProposeCreateRequest = CreateKnowledgeRequest.extend({
  /** Why this is worth recording. Shown to whoever reviews it. */
  reason: z.string().trim().max(2000).optional(),
  /** The proposer's own estimate, 0 to 1. Never a decision on its own. */
  confidence: z.number().min(0).max(1).optional(),
});
export type ProposeCreateRequest = z.infer<typeof ProposeCreateRequest>;

/**
 * What a proposal turned into.
 *
 * `applied` when policy let it through and the item exists now; `pending` when
 * it is waiting for a reviewer. A denial is not a result — it is an error.
 */
export const ProposalResult = z.object({
  proposal: ProposalSummary,
  /** The item, when the proposal was applied straight away. */
  item_id: KnowledgeItemId.nullable(),
});
export type ProposalResult = z.infer<typeof ProposalResult>;

export const ProposalsResponse = z.object({ proposals: z.array(ProposalSummary) });
export type ProposalsResponse = z.infer<typeof ProposalsResponse>;

export const ProposalResponse = z.object({ proposal: ProposalDetail });
export type ProposalResponse = z.infer<typeof ProposalResponse>;
