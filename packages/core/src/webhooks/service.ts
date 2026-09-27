import { createHmac, timingSafeEqual } from 'node:crypto';

import type { EventType, WebhookId, WorkspaceId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventRecord } from '../ledger/types.ts';
import type { EventRepository } from '../ledger/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { CategoryRepository } from '../taxonomy/repository.ts';
import type { WebhookPatch, WebhookRecord, WebhookRepository } from './repository.ts';

/** How many events one delivery may carry. */
export const MAX_EVENTS_PER_DELIVERY = 100;

/** How long to wait for a receiver before calling it a failure. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** The header a receiver verifies, and the one it verifies against. */
export const SIGNATURE_HEADER = 'x-knoverge-signature';
export const TIMESTAMP_HEADER = 'x-knoverge-timestamp';

/**
 * The signature over one delivery.
 *
 * The timestamp is in the signed material rather than beside it, so a body
 * captured today cannot be replayed tomorrow with its own signature intact. A
 * receiver compares digests, never strings.
 */
export function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** For a receiver written in this codebase, and for the tests that stand in for one. */
export function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * How long to wait after a failure, doubling and capped.
 *
 * A receiver that is down for an hour should not be asked a thousand times, and
 * one that was down for a minute should not wait an hour. Nothing is dropped
 * while it waits: the cursor stays where it was, so the events are still there.
 */
export function backoffMs(failures: number): number {
  return Math.min(30 * 60_000, 2 ** Math.min(failures, 10) * 1000);
}

/** What a delivery attempt did, for the sweep's own report. */
export interface DeliveryOutcome {
  webhookId: WebhookId;
  delivered: number;
  ok: boolean;
  error?: string;
}

export interface WebhookServiceOptions {
  uow: UnitOfWork;
  webhooks: WebhookRepository;
  events: EventRepository;
  categories: CategoryRepository;
  /** Sealing and opening the signing secret. The key lives outside the database. */
  seal: (plaintext: string) => string;
  open: (sealed: string) => string;
  /** A fresh signing secret, when the caller does not bring one. */
  newSecret: () => string;
  /**
   * Posting a delivery. Injected so a test is a receiver rather than a network.
   *
   * The default is `fetch`, which is the only outbound call this product makes
   * that the operator did not configure per request (rule 12 makes configuring it
   * the point).
   */
  post?: (
    url: string,
    body: string,
    headers: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number }>;
  clock?: Clock;
}

/**
 * Pushing word that something happened, to a place the operator named.
 *
 * What is delivered is the event and never the object (ADR 0029): a URL is not an
 * actor, holds no read scope, and handing one knowledge text would give an
 * unauthenticated address what no credential is guaranteed to be allowed to read.
 * A receiver that wants the item asks for it with a credential of its own.
 */
export class WebhookService {
  private readonly o: WebhookServiceOptions;
  private readonly clock: Clock;

  constructor(options: WebhookServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async list(workspaceId: WorkspaceId): Promise<WebhookRecord[]> {
    return this.o.webhooks.list(workspaceId);
  }

  /**
   * Creates or changes one.
   *
   * A new endpoint starts at the workspace's current sequence rather than at
   * zero: an operator adding a webhook to a workspace with ten thousand events
   * wants what happens next, not a replay of everything that ever happened.
   */
  async upsert(
    workspaceId: WorkspaceId,
    input: {
      webhookId?: WebhookId;
      url: string;
      secret?: string;
      eventTypes: EventType[];
      status: 'active' | 'disabled';
    },
  ): Promise<{ webhook: WebhookRecord; secret: string | null }> {
    const now = this.clock.now();
    if (input.webhookId) {
      const existing = await this.o.webhooks.findById(workspaceId, input.webhookId);
      if (!existing) {
        throw new DomainError('NOT_FOUND', 'no webhook with that id', {
          objectIds: { webhook: input.webhookId },
        });
      }
      const patch: WebhookPatch = {
        url: input.url,
        eventTypes: input.eventTypes,
        status: input.status,
        // A change is a reason to try again: an endpoint that was failing because
        // its URL was wrong is not still failing once the URL is right.
        failures: 0,
        nextAttemptAt: null,
        updatedAt: now,
        ...(input.secret ? { secretCiphertext: this.o.seal(input.secret) } : {}),
      };
      await this.o.uow.run((tx) => this.o.webhooks.update(tx, workspaceId, existing.id, patch));
      const updated = await this.o.webhooks.findById(workspaceId, existing.id);
      return { webhook: updated as WebhookRecord, secret: null };
    }

    const secret = input.secret ?? this.o.newSecret();
    const webhook: WebhookRecord = {
      id: newId('hook') as WebhookId,
      workspaceId,
      url: input.url,
      secretCiphertext: this.o.seal(secret),
      eventTypes: [...input.eventTypes],
      status: input.status,
      // From here on, not from the beginning.
      cursor: await this.o.events.latestSequence(workspaceId),
      failures: 0,
      nextAttemptAt: null,
      lastDeliveryAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.o.uow.run((tx) => this.o.webhooks.insert(tx, webhook));
    // Once, like an agent's token: it is sealed at rest and cannot be read back.
    return { webhook, secret: input.secret ? null : secret };
  }

  async remove(workspaceId: WorkspaceId, webhookId: WebhookId): Promise<void> {
    const existing = await this.o.webhooks.findById(workspaceId, webhookId);
    if (!existing) {
      throw new DomainError('NOT_FOUND', 'no webhook with that id', {
        objectIds: { webhook: webhookId },
      });
    }
    await this.o.uow.run((tx) => this.o.webhooks.remove(tx, workspaceId, webhookId));
  }

  /** One pass over every endpoint that is due an attempt. */
  async deliverDue(limit = 50): Promise<DeliveryOutcome[]> {
    const now = this.clock.now();
    const due = await this.o.webhooks.listDue(now, limit);
    const outcomes: DeliveryOutcome[] = [];
    for (const webhook of due) outcomes.push(await this.deliver(webhook));
    return outcomes;
  }

  /**
   * One endpoint, one batch.
   *
   * The cursor moves only on a delivery the receiver accepted, so a failure
   * resends rather than skips. At least once, in order, keyed on an event id that
   * does not change — which is what a receiver that must not act twice uses.
   */
  private async deliver(webhook: WebhookRecord): Promise<DeliveryOutcome> {
    const events = await this.o.events.listFeed(webhook.workspaceId, {
      afterSequence: webhook.cursor,
      limit: MAX_EVENTS_PER_DELIVERY,
      ...(webhook.eventTypes.length ? { eventTypes: webhook.eventTypes } : {}),
    });
    if (events.length === 0) {
      // Nothing to say. Not a failure and not an attempt: the sweep will look
      // again, and the endpoint's own error stays whatever it was.
      return { webhookId: webhook.id, delivered: 0, ok: true };
    }

    const now = this.clock.now();
    const paths = await this.categoryPaths(webhook.workspaceId);
    const body = JSON.stringify({
      workspace_id: webhook.workspaceId,
      webhook_id: webhook.id,
      delivered_at: now.toISOString(),
      events: events.map((event) => summarise(event, paths)),
    });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const secret = this.o.open(webhook.secretCiphertext);
    const headers = {
      'content-type': 'application/json',
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(secret, timestamp, body),
    };

    const post = this.o.post ?? defaultPost;
    let failure: string | undefined;
    try {
      const answer = await post(webhook.url, body, headers);
      if (!answer.ok) failure = `the endpoint answered ${answer.status}`;
    } catch (error) {
      // The message and not the body: a receiver's error page is somebody else's
      // content, and this is stored and shown to an operator.
      failure = error instanceof Error ? error.message : String(error);
    }

    const last = events[events.length - 1] as EventRecord;
    const patch: WebhookPatch = failure
      ? {
          failures: webhook.failures + 1,
          nextAttemptAt: new Date(now.getTime() + backoffMs(webhook.failures + 1)),
          lastError: failure.slice(0, 500),
          updatedAt: now,
        }
      : {
          cursor: last.sequence,
          failures: 0,
          nextAttemptAt: null,
          lastDeliveryAt: now,
          lastError: null,
          updatedAt: now,
        };
    await this.o.uow.run((tx) =>
      this.o.webhooks.update(tx, webhook.workspaceId, webhook.id, patch),
    );
    return {
      webhookId: webhook.id,
      delivered: failure ? 0 : events.length,
      ok: !failure,
      ...(failure ? { error: failure } : {}),
    };
  }

  private async categoryPaths(workspaceId: WorkspaceId): Promise<Map<string, string>> {
    const tree = await this.o.categories.list(workspaceId, { includeArchived: true });
    return new Map(tree.map((category) => [category.id, category.path]));
  }
}

/**
 * The same shape `events_list` serves, built here rather than imported from the
 * server: the domain is where the rule about what an event may carry lives, and
 * this is the one place it leaves the installation.
 */
function summarise(event: EventRecord, paths: Map<string, string>): Record<string, unknown> {
  return {
    id: event.id,
    sequence: event.sequence,
    event_type: event.eventType,
    object_type: event.objectType,
    object_id: event.objectId,
    actor_id: event.actorId,
    agent_id: event.agentId,
    request_id: event.requestId,
    session_id: event.sessionId,
    client: event.client,
    provider: event.provider,
    model: event.model,
    before_revision_id: event.beforeRevisionId,
    before_content_hash: event.beforeContentHash,
    after_revision_id: event.afterRevisionId,
    after_content_hash: event.afterContentHash,
    proposal_id: event.proposalId,
    category_paths: event.categoryIds.flatMap((id) => {
      const path = paths.get(id);
      return path ? [path] : [];
    }),
    metadata: event.metadata,
    created_at: event.createdAt.toISOString(),
  };
}

/** `fetch`, with a timeout and no redirects. */
async function defaultPost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number }> {
  const answer = await fetch(url, {
    method: 'POST',
    body,
    headers,
    // A redirect would deliver a signed body to a host the operator did not
    // configure, which is the one thing rule 12 asks this never to do.
    redirect: 'error',
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  return { ok: answer.ok, status: answer.status };
}
