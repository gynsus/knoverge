import { z } from 'zod';

import { EventSummary, EventType } from './events.ts';
import { WebhookId, WorkspaceId } from './ids.ts';

/**
 * Where a workspace pushes word that something happened.
 *
 * A notification and not the knowledge (ADR 0029): the body is a batch of the
 * same event summaries `events_list` serves, and a receiver that wants the item
 * fetches it with a credential of its own. A URL is not an actor and holds no
 * read scope, so delivering content to one would hand an unauthenticated address
 * what no credential is guaranteed to be allowed to read.
 */
export const WebhookStatus = z.enum(['active', 'disabled']);
export type WebhookStatus = z.infer<typeof WebhookStatus>;

export const WebhookSummary = z.object({
  id: WebhookId,
  workspace_id: WorkspaceId,
  url: z.string(),
  /** Which event types are delivered. Empty means every type. */
  event_types: z.array(EventType),
  status: WebhookStatus,
  /** How far down the workspace's ledger this endpoint has been told. */
  cursor: z.number().int().nonnegative(),
  /** Consecutive failures; the wait before the next attempt grows with it. */
  failures: z.number().int().nonnegative(),
  last_delivery_at: z.iso.datetime({ offset: true }).nullable(),
  /** What went wrong last. Never a secret and never a response body. */
  last_error: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type WebhookSummary = z.infer<typeof WebhookSummary>;

export const WebhooksResponse = z.object({ webhooks: z.array(WebhookSummary) });
export type WebhooksResponse = z.infer<typeof WebhooksResponse>;

/**
 * Creating or changing one.
 *
 * The secret is write-only: given here, sealed at rest, and never served back. A
 * request that leaves it out keeps the secret the webhook already has, so an
 * operator can change the URL without handling it.
 */
export const UpsertWebhookRequest = z.object({
  webhook_id: WebhookId.optional(),
  url: z
    .url()
    .max(2048)
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'a webhook is delivered over http or https',
    }),
  /** At least 32 characters. Generated for you when a new webhook leaves it out. */
  secret: z.string().min(32).max(200).optional(),
  event_types: z.array(EventType).max(40).default([]),
  status: WebhookStatus.default('active'),
  request_id: z.string().max(128).optional(),
});
export type UpsertWebhookRequest = z.infer<typeof UpsertWebhookRequest>;

export const UpsertWebhookResponse = z.object({
  webhook: WebhookSummary,
  /**
   * The signing secret, when this call is what created it.
   *
   * Shown once, like an agent's token: it is sealed at rest and cannot be read
   * back. A caller that supplied its own gets nothing here.
   */
  secret: z.string().nullable(),
});
export type UpsertWebhookResponse = z.infer<typeof UpsertWebhookResponse>;

export const DeleteWebhookRequest = z.object({
  webhook_id: WebhookId,
  request_id: z.string().max(128).optional(),
});
export type DeleteWebhookRequest = z.infer<typeof DeleteWebhookRequest>;

/** What a delivery carries, and what a receiver verifies the signature over. */
export const WebhookDelivery = z.object({
  /** The workspace these events came from. */
  workspace_id: WorkspaceId,
  webhook_id: WebhookId,
  /** When the body was signed, which is part of the signed material. */
  delivered_at: z.iso.datetime({ offset: true }),
  events: z.array(EventSummary),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;
