import {
  ItemType,
  type KnowledgeIndexInput,
  type KnowledgeIndexRecord,
  type KnowledgeIndexResponse,
  type WorkspaceManifest,
  type WorkspaceManifestInput,
} from '@knoverge/contracts';
import { DomainError } from '@knoverge/core';
import type { FastifyRequest } from 'fastify';

import { requireListPermission, resolveWorkspaceActor } from '../plugins/actor-context.ts';
import type { Services } from '../services.ts';

/**
 * The version of the tool contract, bumped when a tool's shape changes in a
 * way a client has to notice. Not the server's version: a client cares which
 * contract it is talking to, not which build.
 */
const CONTRACT_VERSION = '1';

/** How much of the body an index record carries. */
const ABSTRACT_CHARS = 280;

/**
 * A compact description of the workspace, for an agent with no context.
 *
 * The first call a client makes. It says what the workspace is, where the two
 * cursors are, what this caller may actually do, and how much is here — so a
 * client can decide what to do next without a dozen exploratory calls.
 *
 * The capabilities are the caller's own, worked out the way every other
 * decision is: `can_write_direct` is true only when a policy rule would let
 * this actor write without review, which is a policy question rather than a
 * permission one, and the two give different answers for a trusted agent.
 */
export async function workspaceManifest(
  services: Services,
  request: FastifyRequest,
  _input: WorkspaceManifestInput,
): Promise<WorkspaceManifest> {
  const actor = await resolveWorkspaceActor(services, request);
  const workspaceId = actor.context.workspaceId;
  const workspace = await services.repositories.workspaces.findById(workspaceId);
  if (!workspace) throw new DomainError('NOT_FOUND', 'workspace not found');

  const held = new Set(await services.authorization.heldActions(actor.context, actor.standing));
  const may = (action: string) => held.has(action as never);
  // A rule, not a permission: rule 14 says a trusted agent holding
  // knowledge.write still waits for review unless a rule says otherwise.
  const direct = may('knowledge.write')
    ? (await services.authorization.policyFor(
        actor.context,
        actor.standing,
        'knowledge.create',
      )) === 'allow_direct'
    : false;

  const categories = await services.repositories.categories.list(workspaceId, {});
  const pending = await services.repositories.proposals.list(workspaceId, {
    status: 'pending',
    limit: 200,
  });
  // The ledger head is where both cursors are: one sequence, two names, as
  // ADR 0010 puts it.
  const head = await services.repositories.events.latestSequence(workspaceId);

  return {
    server: {
      name: 'knoverge',
      version: services.serverVersion,
      contract_version: CONTRACT_VERSION,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      default_language: workspace.defaultLanguage,
    },
    taxonomy_version: await services.taxonomy.currentVersion(workspaceId),
    change_sequence: head,
    event_sequence: head,
    knowledge_types: [...ItemType.options],
    capabilities: {
      can_read: may('knowledge.read'),
      can_propose: may('knowledge.propose_create'),
      can_propose_taxonomy: may('taxonomy.propose'),
      can_write_direct: direct,
      can_approve: may('knowledge.approve'),
      can_manage_taxonomy: may('taxonomy.manage'),
      // Milestone 6 turns this on with the embedding profiles behind it.
      semantic_search: false,
    },
    stats: {
      items: await services.repositories.knowledge.countFor(workspaceId),
      categories: categories.length,
      pending_proposals: pending.length,
    },
  } as WorkspaceManifest;
}

/**
 * Compact index pages, for reconciliation.
 *
 * What an agent reads to decide what the workspace already knows, before it
 * proposes anything. One small record per item, so a whole workspace fits in
 * a few pages; the abstract is deliberately short, enough to match against
 * and not enough to work from — an agent that wants the knowledge calls
 * `knowledge_get`.
 *
 * The cursor is the item id, which sorts in creation order, so a page taken
 * while items are being added does not repeat or skip.
 */
export async function knowledgeIndex(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeIndexInput,
): Promise<KnowledgeIndexResponse> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const workspaceId = actor.context.workspaceId;

  const tree = await services.repositories.categories.list(workspaceId, { includeArchived: true });
  const pathOf = new Map<string, string>(tree.map((c) => [c.id, c.path]));
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

  const summaries = await services.knowledge.list(actor.context, {
    limit: input.limit + 1,
    ...(input.cursor ? { after: input.cursor } : {}),
  });
  const rows = await services.repositories.knowledge.categoriesOf(
    workspaceId,
    summaries.map((entry) => entry.item.id),
  );
  const byItem = new Map<string, string[]>();
  for (const row of rows) {
    byItem.set(row.knowledgeItemId, [...(byItem.get(row.knowledgeItemId) ?? []), row.categoryId]);
  }

  const matching = summaries.filter((entry) => {
    const ids = byItem.get(entry.item.id) ?? [];
    if (wanted.size > 0 && !ids.some((id) => wanted.has(id))) return false;
    if (input.updated_after && entry.item.updatedAt <= new Date(input.updated_after)) return false;
    return true;
  });
  const visible = await services.authorization.filter(
    actor.context,
    actor.standing,
    'knowledge.read',
    matching,
    (entry) => ({ categoryIds: byItem.get(entry.item.id) ?? [] }),
  );
  const page = visible.slice(0, input.limit);

  // The bodies from the search projection rather than from Git: this is a
  // page of up to five hundred items, and five hundred file reads to produce
  // five hundred short abstracts is not a trade anybody would make.
  const bodies = await services.repositories.search.bodiesFor(
    workspaceId,
    page.map((entry) => entry.item.id),
  );

  const records: KnowledgeIndexRecord[] = [];
  for (const entry of page) {
    const revision = entry.item.currentRevisionId
      ? await services.repositories.revisions.findById(workspaceId, entry.item.currentRevisionId)
      : null;
    if (!revision) continue;
    records.push({
      item_id: entry.item.id,
      title: entry.title,
      type: entry.item.type,
      category_paths: (byItem.get(entry.item.id) ?? []).flatMap((id) => {
        const path = pathOf.get(id);
        return path ? [path] : [];
      }),
      status: entry.item.status,
      review_state: entry.item.reviewState,
      evidence_state: entry.item.evidenceState,
      disputed: entry.item.disputed,
      language: entry.item.language,
      revision_id: revision.id,
      content_hash: revision.contentHash,
      source_system: entry.item.sourceSystem,
      external_key: entry.item.externalKey,
      updated_at: entry.item.updatedAt.toISOString(),
      abstract: abstractOf(bodies.get(entry.item.id) ?? ''),
    } as KnowledgeIndexRecord);
  }

  return {
    records,
    next_cursor: page.length > 0 ? (page[page.length - 1]!.item.id as never) : null,
    has_more: visible.length > input.limit,
  };
}

/** The opening of the body, cut at a word so it reads as a sentence. */
function abstractOf(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= ABSTRACT_CHARS) return text;
  const cut = text.slice(0, ABSTRACT_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${space > ABSTRACT_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}
