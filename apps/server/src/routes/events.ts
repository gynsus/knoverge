import type { EventsListInput, EventsListResponse, EventSummary } from '@knoverge/contracts';
import { DomainError, type EventRecord } from '@knoverge/core';
import type { FastifyRequest } from 'fastify';

import { resolveWorkspaceActor } from '../plugins/actor-context.ts';
import type { Services } from '../services.ts';

function summary(event: EventRecord, pathOf: Map<string, string>): EventSummary {
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
    // The snapshot the event carries, as paths. A category renamed since is
    // shown under the name it has now, which is what a reader recognises.
    category_paths: event.categoryIds.flatMap((id) => {
      const path = pathOf.get(id);
      return path ? [path] : [];
    }),
    metadata: event.metadata,
    created_at: event.createdAt.toISOString(),
  } as EventSummary;
}

/**
 * The audit feed: what happened, and who made it happen.
 *
 * `events.read_all` returns everything in the workspace; `events.read_own`
 * returns only what this actor did, which is what an agent holds by default.
 * Synchronisation belongs in `knowledge_changes` instead: that feed answers
 * the caller's read scope and names no actors (ADR 0010).
 *
 * The cursor is the per-workspace ledger sequence, which is gapless and
 * totally ordered. Object ids are never cursors.
 *
 * No `GET` beside the tool route yet: nothing in the browser reads this, and
 * a query-string schema for a feed with two array filters would exist only to
 * be untested. It arrives with the page that wants it (ADR 0011).
 */
export async function eventsList(
  services: Services,
  request: FastifyRequest,
  input: EventsListInput,
): Promise<EventsListResponse> {
  const actor = await resolveWorkspaceActor(services, request);
  const workspaceId = actor.context.workspaceId;
  const all = await services.authorization.check(actor.context, actor.standing, 'events.read_all');
  if (!all.allowed) {
    await services.authorization.require(actor.context, actor.standing, 'events.read_own');
  }

  const tree = await services.repositories.categories.list(workspaceId, { includeArchived: true });
  const pathOf = new Map(tree.map((c) => [c.id, c.path]));
  const categoryIds: string[] = [];
  for (const path of input.category_paths) {
    const category = tree.find((c) => c.path === path);
    if (!category) {
      throw new DomainError('NOT_FOUND', `no category at ${path}`, { objectIds: { path } });
    }
    // The subtree, because asking about a branch means asking about what is
    // under it, exactly as it does for a search.
    for (const c of tree) {
      if (c.path === category.path || c.path.startsWith(`${category.path}/`))
        categoryIds.push(c.id);
    }
  }

  // Whose events. A caller who may only read their own is narrowed to
  // themselves whatever they asked for, so naming somebody else is not a way
  // of reading about an actor they cannot see.
  const actorId = all.allowed ? input.actor_id : actor.context.actorId;

  const events = await services.repositories.events.listFeed(workspaceId, {
    afterSequence: input.after_sequence,
    // One more than asked for, so `has_more` is answered by looking rather
    // than by guessing from a full page.
    limit: input.limit + 1,
    ...(input.event_types.length ? { eventTypes: input.event_types } : {}),
    ...(categoryIds.length ? { categoryIds } : {}),
    ...(actorId ? { actorId } : {}),
    ...(input.newest_first ? { newestFirst: true } : {}),
  });
  const page = events.slice(0, input.limit);
  return {
    events: page.map((event) => summary(event, pathOf)),
    next_sequence: page[page.length - 1]?.sequence ?? input.after_sequence,
    has_more: events.length > input.limit,
  };
}
