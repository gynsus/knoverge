import type {
  ActivityDigestInput,
  ActivityDigestResponse,
  BriefingItem,
  BriefingSectionKind,
  EventType,
  ItemType,
  KnowledgeBriefingInput,
  KnowledgeBriefingResponse,
  WorkspaceId,
} from '@knoverge/contracts';
import { DomainError, type ItemSummary, type KnowledgeItemRecord } from '@knoverge/core';
import type { FastifyRequest } from 'fastify';

import { requireListPermission } from '../plugins/actor-context.ts';
import type { Services } from '../services.ts';
import { proposedTitle } from './proposals.ts';

/** Which section an item type belongs in, for the sections that carry text. */
const SECTION_OF: Partial<Record<ItemType, BriefingSectionKind>> = {
  instruction: 'instructions',
  preference: 'preferences',
  decision: 'decisions',
  procedure: 'procedures',
};

/** At most this many items in a compact section, which only names things. */
const COMPACT_LIMIT = 25;

/**
 * At most this many items in the sections that carry text.
 *
 * The character budget usually bites first; this is the ceiling on how many
 * are considered for it, so a workspace with thousands of instructions does
 * not read them all to answer one briefing.
 */
const CARRYING_LIMIT = 200;

/** How many events one digest reads. A period longer than this is summarised
 * from its most recent part, which is the part anybody asks about. */
const DIGEST_LIMIT = 5000;

/** The categories of several items at once, for scope and for the cards. */
async function categoriesOf(
  services: Services,
  workspaceId: WorkspaceId,
  items: readonly ItemSummary[],
): Promise<Map<string, string[]>> {
  const byItem = new Map<string, string[]>();
  if (items.length === 0) return byItem;
  const rows = await services.repositories.knowledge.categoriesOf(
    workspaceId,
    items.map((entry) => entry.item.id),
  );
  for (const row of rows) {
    byItem.set(row.knowledgeItemId, [...(byItem.get(row.knowledgeItemId) ?? []), row.categoryId]);
  }
  return byItem;
}

/**
 * How much an item is to be trusted, from what the workspace knows about it.
 *
 * A reviewed, source-backed item outranks an unreviewed one that nobody has
 * checked; a disputed one falls below both, because putting a contradiction
 * at the top of a briefing is how a contradiction gets acted on. This is an
 * ordering, not a measurement: the numbers exist to compare items with each
 * other and mean nothing on their own.
 */
function trust(item: KnowledgeItemRecord): number {
  const review =
    item.reviewState === 'human_reviewed' ? 2 : item.reviewState === 'agent_reviewed' ? 1 : 0;
  const evidence =
    item.evidenceState === 'corroborated' ? 2 : item.evidenceState === 'source_backed' ? 1 : 0;
  return review + evidence - (item.disputed ? 5 : 0);
}

/** The opening of a body, which is what survives when the budget runs short. */
function opening(markdown: string): string {
  const trimmed = markdown.trim();
  const end = trimmed.indexOf('\n\n');
  return end > 0 ? trimmed.slice(0, end) : trimmed;
}

/**
 * A token-budgeted context pack for a part of the tree.
 *
 * The first substantive call of a working session. It answers "what should I
 * know before I start", which is a different question from search: nobody has
 * a query yet, and the useful answer is the standing instructions, the
 * settled decisions and what has moved recently.
 *
 * Ordering inside a section is trust, then freshness. When the budget runs
 * out, items are abridged to their opening paragraph before any is dropped,
 * because half of an instruction is worth more than none of it — and
 * `truncated` says when something went, so a caller knows to narrow the
 * request rather than assume this is everything.
 */
export async function knowledgeBriefing(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeBriefingInput,
): Promise<KnowledgeBriefingResponse> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const workspaceId = actor.context.workspaceId;

  const tree = await services.repositories.categories.list(workspaceId, { includeArchived: true });
  const wanted = new Set<string>();
  for (const path of input.category_paths) {
    const category = tree.find((c) => c.path === path);
    if (!category) {
      throw new DomainError('NOT_FOUND', `no category at ${path}`, { objectIds: { path } });
    }
    for (const c of tree) {
      if (c.path === category.path || c.path.startsWith(`${category.path}/`)) wanted.add(c.id);
    }
  }

  // Narrow queries rather than one broad one. Asking for a page of items in
  // creation order and sorting it afterwards answers with the oldest items in
  // the workspace, whatever the caller asked for: a briefing built that way
  // is systematically wrong for any workspace past its first page, and says
  // nothing about it.
  const scoped = {
    status: 'active' as const,
    ...(wanted.size > 0 ? { categoryIds: [...wanted] as never } : {}),
  };
  const carryingTypes = input.types.filter((type) => SECTION_OF[type]);
  const carrying = carryingTypes.length
    ? await services.knowledge.list(actor.context, {
        ...scoped,
        types: carryingTypes,
        limit: CARRYING_LIMIT,
      })
    : [];
  const recent = input.include_recent
    ? await services.knowledge.list(actor.context, {
        ...scoped,
        updatedAfter: new Date(Date.now() - input.recent_days * 24 * 60 * 60 * 1000),
        orderBy: 'updated',
        limit: COMPACT_LIMIT,
      })
    : [];
  const contested = await services.knowledge.list(actor.context, {
    ...scoped,
    disputed: true,
    orderBy: 'updated',
    limit: COMPACT_LIMIT,
  });

  const byItem = await categoriesOf(services, workspaceId, [...carrying, ...recent, ...contested]);
  const visible = async (items: ItemSummary[]) =>
    services.authorization.filter(
      actor.context,
      actor.standing,
      'knowledge.read',
      items,
      (entry) => ({ categoryIds: byItem.get(entry.item.id) ?? [] }),
    );

  // Trust, then freshness: a reviewed, source-backed item outranks one nobody
  // has checked, and a disputed one falls below both.
  const ordered = (await visible(carrying)).sort((a, b) => {
    const byTrust = trust(b.item) - trust(a.item);
    return byTrust !== 0 ? byTrust : b.item.updatedAt.getTime() - a.item.updatedAt.getTime();
  });
  const bodies = await services.repositories.search.bodiesFor(
    workspaceId,
    ordered.map((entry) => entry.item.id),
  );

  const sections = new Map<BriefingSectionKind, BriefingItem[]>();
  const push = (kind: BriefingSectionKind, item: BriefingItem) => {
    sections.set(kind, [...(sections.get(kind) ?? []), item]);
  };

  let spent = 0;
  let truncated = false;
  for (const entry of ordered) {
    const kind = SECTION_OF[entry.item.type]!;
    const full = bodies.get(entry.item.id) ?? '';
    let markdown: string | null = full;
    let abridged = false;
    if (spent + full.length > input.max_chars) {
      const short = opening(full);
      if (spent + short.length > input.max_chars) {
        // No room even for the opening: everything after this is dropped, and
        // the caller is told so rather than left to infer it from a short answer.
        truncated = true;
        continue;
      }
      markdown = short;
      abridged = true;
      truncated = true;
    }
    spent += markdown.length;
    push(kind, {
      item_id: entry.item.id,
      title: entry.title,
      type: entry.item.type,
      revision_id: entry.item.currentRevisionId,
      content_hash: null,
      markdown,
      abridged,
      updated_at: entry.item.updatedAt.toISOString(),
    } as BriefingItem);
  }

  for (const entry of await visible(recent)) push('recent', compact(entry));

  // Anything the workspace itself says is contested. A briefing that hides
  // those is a briefing that gets one of them acted on.
  for (const entry of await visible(contested)) push('open_conflicts', compact(entry));

  const pending = (
    await services.proposals.list(workspaceId, { status: 'pending', limit: COMPACT_LIMIT })
  ).filter(
    (p) =>
      wanted.size === 0 ||
      !p.targetItemId ||
      (byItem.get(p.targetItemId) ?? []).some((id) => wanted.has(id)),
  );
  // Named the way the review inbox names them: what the proposal proposes,
  // or the item it would change. A reader choosing what to look at needs a
  // name, and a proposal that carries no reason has one anyway.
  const proposalTitles = await services.repositories.knowledge.titlesOf(
    workspaceId,
    pending.flatMap((p) => (p.targetItemId ? [p.targetItemId] : [])),
  );
  for (const proposal of pending) {
    push('pending_proposals', {
      item_id: proposal.targetItemId ?? proposal.id,
      title:
        proposedTitle(proposal) ??
        (proposal.targetItemId ? (proposalTitles.get(proposal.targetItemId) ?? null) : null) ??
        proposal.reason,
      type: null,
      revision_id: null,
      content_hash: null,
      markdown: null,
      abridged: false,
      updated_at: proposal.createdAt.toISOString(),
    } as BriefingItem);
  }

  return {
    taxonomy_version: await services.taxonomy.currentVersion(workspaceId),
    change_sequence: await services.repositories.events.latestSequence(workspaceId),
    sections: [...sections].map(([kind, items]) => ({ kind, items })),
    truncated,
  };
}

/** An item named rather than carried, for the sections that only point. */
function compact(entry: ItemSummary): BriefingItem {
  return {
    item_id: entry.item.id,
    title: entry.title,
    type: entry.item.type,
    revision_id: entry.item.currentRevisionId,
    content_hash: null,
    markdown: null,
    abridged: false,
    updated_at: entry.item.updatedAt.toISOString(),
  } as BriefingItem;
}

/**
 * What happened in a period, counted rather than narrated.
 *
 * Rule 9: this works with no AI provider, which is why it is counts and lists
 * rather than prose. Milestone 8 puts a generated narrative on top of exactly
 * this data, and the data stays the answer when there is no provider.
 */
export async function activityDigest(
  services: Services,
  request: FastifyRequest,
  input: ActivityDigestInput,
): Promise<ActivityDigestResponse> {
  const actor = await requireListPermission(services, request, 'events.read_own');
  const workspaceId = actor.context.workspaceId;
  const since = new Date(input.since);
  const until = input.until ? new Date(input.until) : new Date();

  const tree = await services.repositories.categories.list(workspaceId, { includeArchived: true });
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

  const all = await services.authorization.check(actor.context, actor.standing, 'events.read_all');
  // The period is part of the query, and the newest are what a digest is
  // about. Taking the oldest few thousand events and filtering them to a
  // period afterwards answers "nothing happened" for any workspace whose
  // ledger is longer than the page — which is every workspace, eventually.
  const events = await services.repositories.events.listFeed(workspaceId, {
    afterSequence: 0,
    limit: DIGEST_LIMIT,
    since,
    until,
    newestFirst: true,
    ...(categoryIds.length ? { categoryIds } : {}),
    ...(all.allowed ? {} : { actorId: actor.context.actorId }),
  });

  const counts = new Map<EventType, number>();
  const items = new Map<string, { kinds: Set<string>; at: Date }>();
  const proposals = new Map<string, { status: string; at: Date }>();
  for (const event of events) {
    counts.set(event.eventType, (counts.get(event.eventType) ?? 0) + 1);
    if (event.objectType === 'knowledge_item') {
      const entry = items.get(event.objectId) ?? { kinds: new Set<string>(), at: event.createdAt };
      entry.kinds.add(event.eventType.replace('knowledge.', ''));
      if (event.createdAt > entry.at) entry.at = event.createdAt;
      items.set(event.objectId, entry);
    }
    if (event.objectType === 'proposal' && event.eventType.startsWith('proposal.')) {
      proposals.set(event.objectId, {
        status: event.eventType.replace('proposal.', ''),
        at: event.createdAt,
      });
    }
  }

  const titles = await services.repositories.knowledge.titlesOf(workspaceId, [
    ...items.keys(),
  ] as never);

  return {
    since: since.toISOString(),
    until: until.toISOString(),
    counts: [...counts]
      .map(([event_type, count]) => ({ event_type, count }))
      .sort((a, b) => b.count - a.count),
    changed_items: [...items]
      .map(([item_id, entry]) => ({
        item_id,
        title: titles.get(item_id as never) ?? null,
        change_kinds: [...entry.kinds].sort(),
        last_changed_at: entry.at.toISOString(),
      }))
      .sort((a, b) => b.last_changed_at.localeCompare(a.last_changed_at)),
    resolved_proposals: [...proposals].map(([proposal_id, entry]) => ({
      proposal_id,
      status: entry.status,
      resolved_at: entry.at.toISOString(),
    })),
  } as ActivityDigestResponse;
}
