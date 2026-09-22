import type {
  ChangeKindFeed,
  EventType,
  KnowledgeChange,
  KnowledgeChangesInput,
  KnowledgeChangesResponse,
} from '@knoverge/contracts';
import { DomainError, type EventRecord } from '@knoverge/core';
import type { FastifyRequest } from 'fastify';

import { requireListPermission } from '../plugins/actor-context.ts';
import type { Services } from '../services.ts';

/**
 * The event types this feed carries, and what each one means to a client
 * keeping a copy of the knowledge in step.
 *
 * Anything absent is not a knowledge change: an authentication, a permission
 * grant, a proposal nobody has acted on. Those are the audit feed's business.
 */
const KINDS: Partial<Record<EventType, ChangeKindFeed>> = {
  'knowledge.created': 'created',
  'knowledge.updated': 'updated',
  'knowledge.moved': 'moved',
  'knowledge.superseded': 'superseded',
  'knowledge.deleted': 'deleted',
  'knowledge.restored': 'restored',
  'relation.created': 'relation_changed',
  'relation.removed': 'relation_changed',
  'category.created': 'taxonomy_changed',
  'category.updated': 'taxonomy_changed',
  'category.moved': 'taxonomy_changed',
  'category.merged': 'taxonomy_changed',
  'category.archived': 'taxonomy_changed',
  'category.restored': 'taxonomy_changed',
};

const FEED_TYPES = Object.keys(KINDS) as EventType[];

function text(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

function ids(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * What changed, after a checkpoint, limited to what the caller may read.
 *
 * The synchronisation primitive: an agent stores `next_sequence` and asks
 * again from it. The cursor is the per-workspace ledger sequence, which is
 * gapless and totally ordered, so nothing between two checkpoints is missed
 * and nothing is seen twice (ADR 0010).
 *
 * No actors. Who made a change is the audit feed's question, and a client
 * keeping a copy in step does not need it — asking for it would mean asking
 * for `events.read_all`, which is the whole trail of everybody's behaviour.
 *
 * An item that left the caller's scope reaches them as a change they can see,
 * because each event carries the categories it touched on both sides. Without
 * that the item would simply stop appearing, and a client would keep a copy of
 * something it is no longer allowed to have.
 */
export async function knowledgeChanges(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeChangesInput,
): Promise<KnowledgeChangesResponse> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const workspaceId = actor.context.workspaceId;

  const tree = await services.repositories.categories.list(workspaceId, { includeArchived: true });
  const pathOf = new Map<string, string>(tree.map((c) => [c.id, c.path]));
  const categoryIds: string[] = [];
  for (const path of input.category_paths) {
    const category = tree.find((c) => c.path === path);
    if (!category) {
      throw new DomainError('NOT_FOUND', `no category at ${path}`, { objectIds: { path } });
    }
    for (const c of tree) {
      if (c.path === category.path || c.path.startsWith(`${category.path}/`))
        categoryIds.push(c.id);
    }
  }

  const events = await services.repositories.events.listFeed(workspaceId, {
    afterSequence: input.after_sequence,
    // One more than asked for, so `has_more` is answered by looking. It is
    // computed before the scope filter, because more may exist in the ledger
    // even when nothing on this page survived.
    limit: input.limit + 1,
    eventTypes: FEED_TYPES,
    ...(categoryIds.length ? { categoryIds } : {}),
  });
  const page = events.slice(0, input.limit);
  const hasMore = events.length > input.limit;

  const visible = await services.authorization.filter(
    actor.context,
    actor.standing,
    'knowledge.read',
    page,
    (event: EventRecord) => ({ categoryIds: event.categoryIds }),
  );

  const paths = (list: string[]): string[] =>
    list.flatMap((id) => {
      const path = pathOf.get(id);
      return path ? [path] : [];
    });

  return {
    changes: visible.map<KnowledgeChange>((event) => {
      const before = ids(event.metadata, 'categories_before');
      const after = ids(event.metadata, 'categories_after');
      return {
        sequence: event.sequence,
        change_kind: KINDS[event.eventType] as ChangeKindFeed,
        item_id: event.objectId,
        revision_id: text(event.metadata, 'revision') ?? event.afterRevisionId,
        content_hash: text(event.metadata, 'content_hash') ?? event.afterContentHash,
        frontmatter_hash: text(event.metadata, 'frontmatter_hash'),
        // A taxonomy event carries no item categories; the snapshot it does
        // carry is the category it was about, which is the same on both sides.
        category_paths_before: paths(before.length || after.length ? before : event.categoryIds),
        category_paths_after: paths(before.length || after.length ? after : event.categoryIds),
        taxonomy_version: Number(event.metadata['taxonomy_version'] ?? 0),
        changed_at: event.createdAt.toISOString(),
      } as KnowledgeChange;
    }),
    next_sequence: page[page.length - 1]?.sequence ?? input.after_sequence,
    has_more: hasMore,
    taxonomy_version: await services.taxonomy.currentVersion(workspaceId),
  };
}
