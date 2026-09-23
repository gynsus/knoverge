import type {
  KnowledgeItemId,
  SyncBeginInput,
  SyncBeginResult,
  SyncCompleteInput,
  SyncCompleteResult,
  SyncGetMatchesInput,
  SyncMatch,
  SyncMatchesResult,
  SyncStatusInput,
  SyncStatusResult,
  SyncSubmitInventoryInput,
} from '@knoverge/contracts';
import type { SyncCandidateRecord, SyncSessionRecord } from '@knoverge/core';
import type { FastifyRequest } from 'fastify';

import { SyncClassification } from '@knoverge/contracts';

import { requireListPermission } from '../plugins/actor-context.ts';
import type { Services } from '../services.ts';

/**
 * Every classification, including the ones nothing fell into.
 *
 * A caller reading `counts.conflict` should not have to tell "none" from "the
 * server did not say"; zero conflicts is a true statement and an absent key is
 * a question.
 */
function countsOf(byClassification: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    SyncClassification.options.map((name) => [name, byClassification[name] ?? 0]),
  );
}

/** How many roots to suggest reading the index from first. */
const RECOMMENDED_ROOTS = 5;

function toMatch(record: SyncCandidateRecord): SyncMatch {
  const reason = record.serverReason?.['explanation'];
  return {
    client_candidate_id: record.clientCandidateId,
    classification: record.classification,
    classification_state: record.classificationState,
    match_reason: record.matchReason,
    matched_item_ids: record.matchedItemIds as KnowledgeItemId[],
    reason: typeof reason === 'string' ? reason : '',
  };
}

/**
 * Which of these items this caller may read.
 *
 * Reconciliation must not become a way to enumerate restricted categories
 * (`AGENT_ONBOARDING_AND_RECONCILIATION.md` section 19), so a match outside
 * the caller's scope is not a match they hear about: the candidate is
 * classified as though nothing matched. The duplicate check on the eventual
 * proposal still runs, so the workspace is protected either way.
 */
function readableItems(services: Services, request: FastifyRequest) {
  return async (itemIds: readonly KnowledgeItemId[]): Promise<Set<string>> => {
    if (itemIds.length === 0) return new Set();
    const actor = await requireListPermission(services, request, 'knowledge.read');
    const categories = await services.repositories.knowledge.categoriesOf(
      actor.context.workspaceId,
      itemIds,
    );
    const byItem = new Map<string, string[]>();
    for (const row of categories) {
      byItem.set(row.knowledgeItemId, [...(byItem.get(row.knowledgeItemId) ?? []), row.categoryId]);
    }
    const allowed = await services.authorization.filter(
      actor.context,
      actor.standing,
      'knowledge.read',
      [...itemIds],
      (itemId: KnowledgeItemId) => ({ categoryIds: byItem.get(itemId) ?? [] }),
    );
    return new Set(allowed);
  };
}

export async function syncBegin(
  services: Services,
  request: FastifyRequest,
  input: SyncBeginInput,
): Promise<SyncBeginResult> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const workspaceId = actor.context.workspaceId;
  const [taxonomyVersion, changeSequence] = await Promise.all([
    services.taxonomy.currentVersion(workspaceId),
    services.repositories.events.latestSequence(workspaceId),
  ]);

  const session = await services.sync.begin(actor.context, input, {
    taxonomyVersion,
    changeSequence,
  });
  const checkpoint = await services.sync.previousCheckpoint(actor.context, {
    system: session.sourceSystem,
    namespace: session.sourceNamespace,
  });

  // Where the knowledge actually is, biggest branch first: an agent with a
  // budget reads those and stops, rather than paging the whole index.
  const categories = await services.taxonomy.list(workspaceId, {});
  const roots = categories
    .filter((c) => c.parentId === null)
    .sort((a, b) => b.subtreeItemCount - a.subtreeItemCount)
    .slice(0, RECOMMENDED_ROOTS)
    .map((c) => ({ root_path: c.path, item_count: c.subtreeItemCount }));

  return {
    sync_session_id: session.id,
    workspace_id: workspaceId,
    taxonomy_version: session.taxonomyVersion,
    change_sequence: session.changeSequenceAtStart,
    previous_checkpoint:
      checkpoint && checkpoint.lastCompletedSyncId && checkpoint.lastCompletedAt
        ? {
            sync_session_id: checkpoint.lastCompletedSyncId,
            change_sequence: checkpoint.lastChangeSequence ?? 0,
            taxonomy_version: checkpoint.lastTaxonomyVersion ?? 0,
            completed_at: checkpoint.lastCompletedAt.toISOString(),
          }
        : null,
    recommended_index_queries: roots,
    stats: {
      items: await services.repositories.knowledge.countFor(workspaceId),
      categories: categories.length,
    },
    expires_at: session.expiresAt.toISOString(),
  };
}

export async function syncSubmitInventory(
  services: Services,
  request: FastifyRequest,
  input: SyncSubmitInventoryInput,
): Promise<SyncMatchesResult> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const { records } = await services.sync.submitInventory(
    actor.context,
    input.sync_session_id,
    input.candidates,
    readableItems(services, request),
  );
  // The classifications are already recorded, so a runner that cannot be
  // reached costs the agent a poll rather than its inventory. It is told
  // through `pending_count`, and an operator through the log.
  await services.enqueueRefine(actor.context.workspaceId, input.sync_session_id).catch((err) => {
    request.log.warn({ err, sync_session_id: input.sync_session_id }, 'could not queue refinement');
  });

  const counts = await services.repositories.sync.countCandidates(input.sync_session_id);
  return {
    sync_session_id: input.sync_session_id,
    matches: records.map(toMatch),
    pending_count: counts.pending,
    next_cursor: null,
  };
}

export async function syncGetMatches(
  services: Services,
  request: FastifyRequest,
  input: SyncGetMatchesInput,
): Promise<SyncMatchesResult> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const session = await services.sync.requireSession(actor.context, input.sync_session_id);
  const page = await services.repositories.sync.listCandidates(session.id, {
    onlyFinal: input.only_final,
    ...(input.cursor ? { after: input.cursor } : {}),
    limit: input.limit,
  });
  const counts = await services.repositories.sync.countCandidates(session.id);
  return {
    sync_session_id: session.id,
    matches: page.map(toMatch),
    pending_count: counts.pending,
    // The id of the last row, because ids sort in creation order and a cursor
    // over them neither repeats nor skips.
    next_cursor: page.length === input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

function statusOf(
  session: SyncSessionRecord,
  counts: { byClassification: Record<string, number>; pending: number; total: number },
): SyncStatusResult {
  return {
    sync_session_id: session.id,
    agent_id: session.agentId,
    source_system: session.sourceSystem,
    source_namespace: session.sourceNamespace,
    state: session.state,
    counts: countsOf(counts.byClassification) as SyncStatusResult['counts'],
    candidate_count: counts.total,
    pending_count: counts.pending,
    taxonomy_version: session.taxonomyVersion,
    change_sequence_at_start: session.changeSequenceAtStart,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
    completed_at: session.completedAt?.toISOString() ?? null,
  };
}

export async function syncStatus(
  services: Services,
  request: FastifyRequest,
  input: SyncStatusInput,
): Promise<SyncStatusResult> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const session = await services.sync.requireSession(actor.context, input.sync_session_id);
  return statusOf(session, await services.repositories.sync.countCandidates(session.id));
}

export async function syncComplete(
  services: Services,
  request: FastifyRequest,
  input: SyncCompleteInput,
): Promise<SyncCompleteResult> {
  const actor = await requireListPermission(services, request, 'knowledge.read');
  const session = await services.sync.complete(actor.context, input.sync_session_id);
  const counts = await services.repositories.sync.countCandidates(session.id);
  return {
    sync_session_id: session.id,
    state: session.state,
    checkpoint: {
      sync_session_id: session.id,
      change_sequence: session.changeSequenceAtStart,
      taxonomy_version: session.taxonomyVersion,
      completed_at: (session.completedAt ?? new Date()).toISOString(),
    },
    counts: countsOf(counts.byClassification) as SyncCompleteResult['counts'],
  };
}
