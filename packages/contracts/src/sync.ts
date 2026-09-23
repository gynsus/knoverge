import { z } from 'zod';

import { AgentId, KnowledgeItemId, WorkspaceId } from './ids.ts';
import { LanguageTag } from './identity.ts';
import { ItemType } from './knowledge.ts';
import { CategoryPath } from './taxonomy.ts';

/** Where a reconciliation pass has got to. */
export const SyncSessionState = z.enum([
  'open',
  'processing',
  'waiting_for_agent',
  'completed',
  'failed',
  'expired',
]);
export type SyncSessionState = z.infer<typeof SyncSessionState>;

/**
 * What the workspace made of one thing an agent offered.
 *
 * `exact_known` the workspace already holds it, skip. `likely_match` probably
 * the same knowledge, read it before changing anything. `new_candidate`
 * nothing matches, propose it. `conflict` both sides have materially different
 * current claims and neither is safely newer. `agent_copy_stale` the
 * workspace's copy is newer. `server_copy_stale` the agent's is.
 * `ambiguous` several items are plausible. `ignored` policy says this should
 * not become durable knowledge.
 */
export const SyncClassification = z.enum([
  'exact_known',
  'likely_match',
  'new_candidate',
  'conflict',
  'agent_copy_stale',
  'server_copy_stale',
  'ambiguous',
  'ignored',
]);
export type SyncClassification = z.infer<typeof SyncClassification>;

/** `final` when nothing later can change it, `provisional` until refined. */
export const ClassificationState = z.enum(['provisional', 'final']);
export type ClassificationState = z.infer<typeof ClassificationState>;

export const MatchReason = z.enum(['external_key', 'content_hash', 'lexical', 'semantic', 'none']);
export type MatchReason = z.infer<typeof MatchReason>;

export const SyncSessionId = z.string().min(1).max(40);
export const SourceSystem = z.string().trim().min(1).max(64);
export const SourceNamespace = z.string().trim().min(1).max(512);
/** A fingerprint as the repository writes one: `sha256:` and 64 hex digits. */
export const ContentFingerprint = z
  .string()
  .trim()
  .max(80)
  .regex(/^sha256:[0-9a-f]{64}$/, 'a sha256: fingerprint');

export const SyncBeginInput = z.object({
  source_system: SourceSystem,
  /**
   * Which body of material this is, within the source system. One agent may
   * carry knowledge from several places and each moves at its own pace, so a
   * checkpoint belongs to a namespace rather than to the agent.
   */
  source_namespace: SourceNamespace.optional(),
  /** A session to resume rather than start. Its candidates are kept. */
  previous_sync_id: SyncSessionId.optional(),
});
export type SyncBeginInput = z.infer<typeof SyncBeginInput>;

/** What an agent was told last time it finished, so it can send only deltas. */
export const SyncCheckpoint = z.object({
  sync_session_id: SyncSessionId,
  change_sequence: z.number().int().nonnegative(),
  taxonomy_version: z.number().int().nonnegative(),
  completed_at: z.iso.datetime(),
});
export type SyncCheckpoint = z.infer<typeof SyncCheckpoint>;

export const SyncBeginResult = z.object({
  sync_session_id: SyncSessionId,
  workspace_id: WorkspaceId,
  taxonomy_version: z.number().int().nonnegative(),
  /** Where the change feed stands now; the checkpoint to resume from later. */
  change_sequence: z.number().int().nonnegative(),
  previous_checkpoint: SyncCheckpoint.nullable(),
  /** Where to read the index from first, given what this agent may see. */
  recommended_index_queries: z.array(
    z.object({ root_path: CategoryPath, item_count: z.number().int().nonnegative() }),
  ),
  stats: z.object({
    items: z.number().int().nonnegative(),
    categories: z.number().int().nonnegative(),
  }),
  expires_at: z.iso.datetime(),
});
export type SyncBeginResult = z.infer<typeof SyncBeginResult>;

/**
 * One thing an agent believes it knows.
 *
 * An abstract, never the material. Matching needs enough to recognise
 * knowledge, and sending the whole of it is the context cost this protocol
 * exists to avoid.
 */
export const SyncCandidateInput = z.object({
  /** Stable across retries, and the idempotency key inside the session. */
  client_candidate_id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  type: ItemType,
  language: LanguageTag.optional(),
  /** A stable identifier in the source system, when the source has one. */
  external_key: z.string().trim().min(1).max(512).optional(),
  /** Fingerprint of the agent's raw source: did my source change? */
  source_content_hash: ContentFingerprint.optional(),
  /** Normalised title and body: does the workspace already hold this text? */
  candidate_content_hash: ContentFingerprint.optional(),
  source_modified_at: z.iso.datetime().optional(),
  proposed_category_paths: z.array(CategoryPath).max(20).default([]),
  abstract: z.string().trim().max(1000).optional(),
});
export type SyncCandidateInput = z.infer<typeof SyncCandidateInput>;

export const SyncSubmitInventoryInput = z.object({
  sync_session_id: SyncSessionId,
  candidates: z.array(SyncCandidateInput).min(1).max(200),
});
export type SyncSubmitInventoryInput = z.infer<typeof SyncSubmitInventoryInput>;

export const SyncMatch = z.object({
  client_candidate_id: z.string(),
  classification: SyncClassification,
  classification_state: ClassificationState,
  match_reason: MatchReason,
  /** Items the workspace thinks this may be, for the agent to read. */
  matched_item_ids: z.array(KnowledgeItemId),
  /** Why, in terms an agent can act on. */
  reason: z.string(),
});
export type SyncMatch = z.infer<typeof SyncMatch>;

export const SyncMatchesResult = z.object({
  sync_session_id: SyncSessionId,
  matches: z.array(SyncMatch),
  /** How many are still provisional; an agent polls until this is zero. */
  pending_count: z.number().int().nonnegative(),
  next_cursor: z.string().nullable(),
});
export type SyncMatchesResult = z.infer<typeof SyncMatchesResult>;

export const SyncGetMatchesInput = z.object({
  sync_session_id: SyncSessionId,
  only_final: z.boolean().default(false),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type SyncGetMatchesInput = z.infer<typeof SyncGetMatchesInput>;

export const SyncStatusInput = z.object({ sync_session_id: SyncSessionId });
export type SyncStatusInput = z.infer<typeof SyncStatusInput>;

export const SyncStatusResult = z.object({
  sync_session_id: SyncSessionId,
  agent_id: AgentId,
  source_system: SourceSystem,
  source_namespace: z.string().nullable(),
  state: SyncSessionState,
  counts: z.record(SyncClassification, z.number().int().nonnegative()),
  candidate_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  taxonomy_version: z.number().int().nonnegative(),
  change_sequence_at_start: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
});
export type SyncStatusResult = z.infer<typeof SyncStatusResult>;

export const SyncCompleteInput = z.object({ sync_session_id: SyncSessionId });
export type SyncCompleteInput = z.infer<typeof SyncCompleteInput>;

export const SyncCompleteResult = z.object({
  sync_session_id: SyncSessionId,
  state: SyncSessionState,
  checkpoint: SyncCheckpoint,
  counts: z.record(SyncClassification, z.number().int().nonnegative()),
});
export type SyncCompleteResult = z.infer<typeof SyncCompleteResult>;
