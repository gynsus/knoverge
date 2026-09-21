import { z } from 'zod';

import { PolicyEffect } from './policy.ts';
import { ActorId, KnowledgeItemId, ProposalId, RevisionId, WorkspaceId } from './ids.ts';
import { LanguageTag } from './identity.ts';
import {
  CreateKnowledgeRequest,
  DeleteKnowledgeRequest,
  FrontmatterRelation,
  FrontmatterSource,
  ItemType,
  SupersedeKnowledgeRequest,
  Tag,
  UpdateKnowledgeRequest,
} from './knowledge.ts';
import { CategoryPath } from './taxonomy.ts';

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
  /**
   * What the proposal is about, for a list that has to name it: the title it
   * proposes, or the current title of the item it would change. Null only
   * when neither exists, which a redacted payload can produce.
   */
  title: z.string().nullable(),
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
  /**
   * Candidates a `DUPLICATE_SUSPECTED` refusal offered and the proposer has
   * read and ruled out. Recorded on the proposal, so a reviewer sees what was
   * considered and dismissed rather than having to wonder.
   */
  acknowledged_duplicate_ids: z.array(KnowledgeItemId).max(20).optional(),
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

/**
 * Proposing a change to an item.
 *
 * `base_revision_id` and `base_content_hash` are what the proposer read.
 * Rule 6 applies to a proposal exactly as it applies to a write: the base is
 * checked when the proposal is made and again when it is approved, because
 * the item may have moved on while the proposal waited.
 */
export const ProposeUpdateRequest = UpdateKnowledgeRequest.extend({
  reason: z.string().trim().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ProposeUpdateRequest = z.infer<typeof ProposeUpdateRequest>;

/** Proposing that an item leave the current index. */
export const ProposeDeleteRequest = DeleteKnowledgeRequest.extend({
  reason: z.string().trim().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type ProposeDeleteRequest = z.infer<typeof ProposeDeleteRequest>;

/**
 * Proposing that one item replace another.
 *
 * The same shape a person supersedes with, plus the proposer's account of
 * why. Approving it runs the same atomic operation: one commit, two
 * revisions, and no half-applied supersession.
 */
export const ProposeSupersedeRequest = SupersedeKnowledgeRequest.safeExtend({
  reason: z.string().trim().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ProposeSupersedeRequest = z.infer<typeof ProposeSupersedeRequest>;

/**
 * What a reviewer may change before approving.
 *
 * The content fields of the proposal and nothing else: `reason` and
 * `confidence` are the proposer's account of their own work, and a reviewer
 * rewriting them would leave a record of a proposal nobody made. A reviewer
 * who disagrees rejects with a note, or approves with the text they want.
 */
export const ProposalEdits = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().min(1).max(200_000).optional(),
  type: ItemType.optional(),
  language: LanguageTag.optional(),
  categories: z.array(CategoryPath).max(20).optional(),
  tags: z.array(Tag).max(50).optional(),
  sources: z.array(FrontmatterSource).max(50).optional(),
  relations: z.array(FrontmatterRelation).max(50).optional(),
});
export type ProposalEdits = z.infer<typeof ProposalEdits>;

/**
 * Making a proposal canonical.
 *
 * `edits` present and not empty makes it `approved_with_edits`: the same
 * decision, recorded so that the resulting revision is not mistaken for what
 * the proposer wrote.
 */
export const ApproveProposalRequest = z.object({
  proposal_id: ProposalId,
  edits: ProposalEdits.optional(),
  /** Why, for whoever reads the trail later. */
  note: z.string().trim().max(2000).optional(),
  request_id: z.string().max(128).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type ApproveProposalRequest = z.infer<typeof ApproveProposalRequest>;

export const RejectProposalRequest = z.object({
  proposal_id: ProposalId,
  /** Recommended: a rejection without one tells the proposer nothing. */
  reason: z.string().trim().max(2000).optional(),
  request_id: z.string().max(128).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type RejectProposalRequest = z.infer<typeof RejectProposalRequest>;

/** Taking back a proposal that is no longer worth deciding. */
export const WithdrawProposalRequest = z.object({
  proposal_id: ProposalId,
  reason: z.string().trim().max(2000).optional(),
  request_id: z.string().max(128).optional(),
});
export type WithdrawProposalRequest = z.infer<typeof WithdrawProposalRequest>;

export const ProposalListInput = z.object({ status: ProposalStatus.optional() });
export type ProposalListInput = z.infer<typeof ProposalListInput>;

export const ProposalGetInput = z.object({ proposal_id: ProposalId });
export type ProposalGetInput = z.infer<typeof ProposalGetInput>;

export const ProposalsResponse = z.object({ proposals: z.array(ProposalSummary) });
export type ProposalsResponse = z.infer<typeof ProposalsResponse>;

export const ProposalResponse = z.object({ proposal: ProposalDetail });
export type ProposalResponse = z.infer<typeof ProposalResponse>;
