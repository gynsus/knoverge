import type { KnowledgeItemId } from '@knoverge/contracts';
import { MAX_LEXICAL_CANDIDATES, TITLE_SIMILARITY_THRESHOLD } from '@knoverge/core';

import type { Services } from './services.ts';

/**
 * Settles a session's provisional candidates, away from any request.
 *
 * The scope is rebuilt from the agent the session belongs to rather than from
 * a caller, because there is none: a job has no request and no bearer token.
 * It is the same question the request asked — what may this agent read — put
 * to the same authorisation service, so a candidate cannot be matched against
 * an item the agent could not have seen.
 */
export async function refineSyncSession(
  services: Services,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const session = await services.repositories.sync.findSession(
    workspaceId as Parameters<typeof services.repositories.sync.findSession>[0],
    sessionId,
  );
  if (!session) return 0;
  const agent = await services.repositories.agents.findById(session.workspaceId, session.agentId);
  if (!agent) return 0;

  const context = {
    workspaceId: session.workspaceId,
    actorId: agent.actorId,
    actorType: 'agent' as const,
    agentId: agent.id,
    requestId: `job:sync.refine:${sessionId}`,
  };
  const standing = { trustTier: agent.trustTier };

  const readable = async (itemIds: readonly KnowledgeItemId[]): Promise<Set<string>> => {
    if (itemIds.length === 0) return new Set();
    const rows = await services.repositories.knowledge.categoriesOf(session.workspaceId, itemIds);
    const byItem = new Map<string, string[]>();
    for (const row of rows) {
      byItem.set(row.knowledgeItemId, [...(byItem.get(row.knowledgeItemId) ?? []), row.categoryId]);
    }
    const allowed = await services.authorization.filter(
      context,
      standing,
      'knowledge.read',
      [...itemIds],
      (itemId: KnowledgeItemId) => ({ categoryIds: byItem.get(itemId) ?? [] }),
    );
    return new Set(allowed);
  };

  return services.sync.refine(session, readable, {
    threshold: TITLE_SIMILARITY_THRESHOLD,
    limit: MAX_LEXICAL_CANDIDATES,
  });
}
