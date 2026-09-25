import { z } from 'zod';

import { ActorId } from './ids.ts';
import { CategoryPath } from './taxonomy.ts';

/**
 * Ledger event types (DATA_MODEL.md section 22). Only material changes are events.
 */
export const EventType = z.enum([
  'workspace.created',
  'workspace.updated',
  'workspace.archived',
  'workspace.restored',
  'user.created',
  'user.password_reset',
  'membership.created',
  'membership.updated',
  'agent.created',
  'agent.updated',
  'agent.credential_issued',
  'agent.credential_revoked',
  'permission.granted',
  'permission.revoked',
  'policy.rule_changed',
  'command.denied',
  'category.proposed',
  'category.created',
  'category.updated',
  'category.moved',
  'category.merged',
  'category.archived',
  'category.restored',
  'knowledge.proposed_create',
  'knowledge.proposed_update',
  'knowledge.proposed_delete',
  'knowledge.proposed_supersede',
  'knowledge.created',
  'knowledge.updated',
  'knowledge.moved',
  'knowledge.superseded',
  'knowledge.deleted',
  'knowledge.restored',
  'knowledge.purged',
  'relation.created',
  'relation.removed',
  'proposal.approved',
  'proposal.rejected',
  'proposal.edited_and_approved',
  'proposal.withdrawn',
  'proposal.conflict',
  'sync.started',
  'sync.completed',
  'sync.expired',
  'summary.generated',
  'summary.marked_stale',
  'attachment.uploaded',
  'attachment.extracted',
  'webhook.changed',
  'integrity.check_completed',
]);
export type EventType = z.infer<typeof EventType>;

export const ObjectType = z.enum([
  'workspace',
  'user',
  'membership',
  'actor',
  'agent',
  'credential',
  'permission',
  'policy_rule',
  'category',
  'knowledge_item',
  'relation',
  'proposal',
  'sync_session',
  'attachment',
  'webhook',
  'command',
  'integrity_check',
]);
export type ObjectType = z.infer<typeof ObjectType>;

/**
 * The audit feed: what happened, and who made it happen.
 *
 * `after_sequence` is a position in the per-workspace ledger sequence, never
 * an object id (ADR 0010). A caller stores the `next_sequence` it was given
 * and passes it back.
 */
export const EventsListInput = z.object({
  after_sequence: z.number().int().nonnegative().default(0),
  event_types: z.array(EventType).max(40).default([]),
  category_paths: z.array(CategoryPath).max(20).default([]),
  /**
   * One actor's events, for the question "what has this agent been doing".
   *
   * Needs `events.read_all`: a caller who may only read their own is already
   * narrowed to themselves, and letting them name somebody else would be a
   * way of asking about an actor they cannot see.
   */
  actor_id: ActorId.optional(),
  /** Newest first, for a caller that wants the last few rather than the first page. */
  newest_first: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200),
});
export type EventsListInput = z.infer<typeof EventsListInput>;
/** The query as a caller writes it, before the schema fills in its defaults. */
export type EventsListQuery = z.input<typeof EventsListInput>;

/**
 * One event as the feed shows it.
 *
 * Ids, hashes, actor context and safe metadata; never knowledge text, a
 * proposal payload or a secret (rule 4).
 */
export const EventSummary = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  event_type: EventType,
  object_type: ObjectType,
  object_id: z.string(),
  actor_id: z.string(),
  agent_id: z.string().nullable(),
  request_id: z.string(),
  session_id: z.string().nullable(),
  client: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  before_revision_id: z.string().nullable(),
  before_content_hash: z.string().nullable(),
  after_revision_id: z.string().nullable(),
  after_content_hash: z.string().nullable(),
  proposal_id: z.string().nullable(),
  category_paths: z.array(CategoryPath),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime({ offset: true }),
});
export type EventSummary = z.infer<typeof EventSummary>;

export const EventsListResponse = z.object({
  events: z.array(EventSummary),
  /** Where to resume. The same as the last event's sequence, or the cursor. */
  next_sequence: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type EventsListResponse = z.infer<typeof EventsListResponse>;

/** What happened in a period, counted rather than narrated. */
export const ActivityDigestInput = z.object({
  since: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }).nullable().default(null),
  category_paths: z.array(CategoryPath).max(20).default([]),
});
export type ActivityDigestInput = z.infer<typeof ActivityDigestInput>;

export const ActivityDigestResponse = z.object({
  since: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  /** How many events of each type, largest first. */
  counts: z.array(z.object({ event_type: EventType, count: z.number().int().positive() })),
  changed_items: z.array(
    z.object({
      item_id: z.string(),
      title: z.string().nullable(),
      change_kinds: z.array(z.string()),
      last_changed_at: z.iso.datetime({ offset: true }),
    }),
  ),
  resolved_proposals: z.array(
    z.object({
      proposal_id: z.string(),
      status: z.string(),
      resolved_at: z.iso.datetime({ offset: true }),
    }),
  ),
});
export type ActivityDigestResponse = z.infer<typeof ActivityDigestResponse>;
