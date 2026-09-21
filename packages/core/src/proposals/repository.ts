import type {
  ActorId,
  CategoryId,
  KnowledgeItemId,
  PolicyEffect,
  ProposalId,
  ProposalStatus,
  ProposalType,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface ProposalRecord {
  id: ProposalId;
  workspaceId: WorkspaceId;
  proposalType: ProposalType;
  targetItemId: KnowledgeItemId | null;
  targetCategoryId: CategoryId | null;
  status: ProposalStatus;
  proposedByActorId: ActorId;
  baseRevisionId: RevisionId | null;
  baseContentHash: string | null;
  /**
   * The only place outside Git where proposed knowledge text lives, which is
   * why purge redacts it.
   */
  proposedPayload: Record<string, unknown>;
  reason: string | null;
  confidence: number | null;
  acknowledgedDuplicateIds: string[];
  syncSessionId: string | null;
  /** How policy decided. A denial never becomes a proposal. */
  policyDecision: Exclude<PolicyEffect, 'deny'>;
  policyRuleId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByActorId: ActorId | null;
  resolutionNote: string | null;
  resultRevisionIds: RevisionId[];
}

export type ProposalPatch = Partial<
  Pick<
    ProposalRecord,
    | 'status'
    | 'resolvedAt'
    | 'resolvedByActorId'
    | 'resolutionNote'
    | 'resultRevisionIds'
    | 'proposedPayload'
  >
>;

export interface ListProposalsOptions {
  status?: ProposalStatus;
  /** Only what this actor proposed, for an agent reading its own. */
  proposedByActorId?: ActorId;
  targetItemId?: KnowledgeItemId;
  limit?: number;
}

export interface ProposalRepository {
  insert(tx: Tx, proposal: ProposalRecord): Promise<void>;
  update(tx: Tx, workspaceId: WorkspaceId, id: ProposalId, patch: ProposalPatch): Promise<void>;
  findById(workspaceId: WorkspaceId, id: ProposalId, tx?: Tx): Promise<ProposalRecord | null>;
  /** Oldest first: a review inbox is a queue, not a feed. */
  list(workspaceId: WorkspaceId, options?: ListProposalsOptions): Promise<ProposalRecord[]>;
  /**
   * Empties the payload of proposals resolved before a date, across every
   * workspace, and answers how many it emptied. The rows stay: who proposed
   * what kind of change, when, and what was decided is the review trail.
   */
  redactResolvedBefore(tx: Tx, before: Date): Promise<number>;
}
