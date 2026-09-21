import { z } from 'zod';

import {
  KnowledgeDiffInput,
  KnowledgeDiffResponse,
  KnowledgeGetInput,
  KnowledgeHistoryInput,
  KnowledgeResponse,
  RevisionsResponse,
} from './knowledge.ts';
import {
  ApproveProposalRequest,
  ProposalGetInput,
  ProposalListInput,
  ProposalResponse,
  ProposalResult,
  ProposalsResponse,
  ProposeCreateRequest,
  ProposeDeleteRequest,
  ProposeSupersedeRequest,
  ProposeUpdateRequest,
  RejectProposalRequest,
  WithdrawProposalRequest,
} from './proposals.ts';
import { TaxonomyListInput, TaxonomyListResponse } from './taxonomy.ts';

/**
 * A tool name, which is also its HTTP path.
 *
 * Lowercase letters, digits and underscores (rule 11). MCP exposes each as a
 * tool; HTTP exposes each at `POST /v1/<name>`. A read that a browser also
 * uses keeps its `GET` alongside, over the same handler (ADR 0011).
 */
export const ToolName = z.enum([
  'taxonomy_list',
  'knowledge_get',
  'knowledge_history',
  'knowledge_diff',
  'knowledge_propose_create',
  'knowledge_propose_update',
  'knowledge_propose_delete',
  'knowledge_propose_supersede',
  'proposal_list',
  'proposal_get',
  'proposal_approve',
  'proposal_reject',
  'proposal_withdraw',
]);
export type ToolName = z.infer<typeof ToolName>;

export interface ToolContract {
  name: ToolName;
  /**
   * What the tool does, in one or two sentences, written for the agent that
   * has to choose between them. English, like every other identifier and
   * description in the codebase.
   */
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  /** False when calling it can change the workspace. */
  readOnly: boolean;
}

/**
 * Every operation offered as a tool, defined once.
 *
 * This is what rule 11 means by one contract: the schemas here are what MCP
 * advertises and what the HTTP route validates, so the two transports cannot
 * drift. Operations that are not tools — authentication, health, workspace
 * administration — are deliberately absent; they have no MCP name to match
 * and are not offered to agents (ADR 0011).
 */
export const TOOLS: readonly ToolContract[] = [
  {
    name: 'taxonomy_list',
    description:
      'The category tree of the workspace, with the taxonomy version it is at. Read this before proposing knowledge, so an item lands in a category that exists.',
    input: TaxonomyListInput,
    output: TaxonomyListResponse,
    readOnly: true,
  },
  {
    name: 'knowledge_get',
    description:
      'One knowledge item: its canonical Markdown body, its metadata, its sources and its relations.',
    input: KnowledgeGetInput,
    output: KnowledgeResponse,
    readOnly: true,
  },
  {
    name: 'knowledge_history',
    description:
      'The revisions of one item, newest first, each with the commit that wrote it and who wrote it.',
    input: KnowledgeHistoryInput,
    output: RevisionsResponse,
    readOnly: true,
  },
  {
    name: 'knowledge_diff',
    description: 'What changed between two revisions of one item, in the body and the metadata.',
    input: KnowledgeDiffInput,
    output: KnowledgeDiffResponse,
    readOnly: true,
  },
  {
    name: 'knowledge_propose_create',
    description:
      'Propose recording something the workspace does not know yet. Answers with a pending proposal unless a policy rule allows the write directly, and refuses when the workspace may already hold it.',
    input: ProposeCreateRequest,
    output: ProposalResult,
    readOnly: false,
  },
  {
    name: 'knowledge_propose_update',
    description:
      'Propose changing an item. Carries the revision and content hash the caller read; a mismatch is a conflict, never an overwrite.',
    input: ProposeUpdateRequest,
    output: ProposalResult,
    readOnly: false,
  },
  {
    name: 'knowledge_propose_delete',
    description:
      'Propose that an item leave the current index. Logical: the file leaves the tree and the history keeps it.',
    input: ProposeDeleteRequest,
    output: ProposalResult,
    readOnly: false,
  },
  {
    name: 'knowledge_propose_supersede',
    description:
      'Propose that one item replace another, when a fact changed rather than was corrected. The old content is kept and marked as no longer current.',
    input: ProposeSupersedeRequest,
    output: ProposalResult,
    readOnly: false,
  },
  {
    name: 'proposal_list',
    description:
      'Proposals in this workspace: the whole queue with proposal.read_all, or only what this actor proposed with proposal.read_own.',
    input: ProposalListInput,
    output: ProposalsResponse,
    readOnly: true,
  },
  {
    name: 'proposal_get',
    description: 'One proposal, with what it proposed and how it was decided.',
    input: ProposalGetInput,
    output: ProposalResponse,
    readOnly: true,
  },
  {
    name: 'proposal_approve',
    description:
      'Make a pending proposal canonical, optionally with edits. Requires knowledge.approve, and no actor may approve its own proposal.',
    input: ApproveProposalRequest,
    output: ProposalResult,
    readOnly: false,
  },
  {
    name: 'proposal_reject',
    description:
      'Refuse a pending proposal, with a reason. The proposal stays in the audit history.',
    input: RejectProposalRequest,
    output: ProposalResult,
    readOnly: false,
  },
  {
    name: 'proposal_withdraw',
    description:
      'Take back a proposal that is no longer worth deciding. The proposer may withdraw their own; anybody else needs knowledge.approve.',
    input: WithdrawProposalRequest,
    output: ProposalResult,
    readOnly: false,
  },
];

/** The contract of one tool, by name. */
export const TOOL_BY_NAME: ReadonlyMap<ToolName, ToolContract> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);
