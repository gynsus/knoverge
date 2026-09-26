import type { KnowledgeItemId } from '@knoverge/contracts';
import type { SummaryDependencyRecord, SummaryRepository, Tx } from '@knoverge/core';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { knowledgeItems, summaryDependencies } from '../schema/knowledge.ts';
import { asTx } from '../unit-of-work.ts';

/**
 * Whether a summary is out of step with what it summarises.
 *
 * Computed, not a column (ADR 0024): true when any revision the summary names is
 * no longer the current revision of the item it names. `is distinct from` rather
 * than `<>`, because an item with no current revision would make `<>` answer
 * null, and a null there reads as "not stale".
 *
 * The one definition. The filter on the list, the count behind the pile and the
 * flag on a row all call this, because three copies of it would be three chances
 * to write it differently and only one of them would be noticed.
 */
export function isStale(): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${summaryDependencies} d
    join ${knowledgeItems} source on source.id = d.source_item_id
    where d.summary_item_id = ${knowledgeItems.id}
      and source.current_revision_id is distinct from d.source_revision_id
  )`;
}

/**
 * What a summary was made from.
 *
 * Replaced whole, and hard rather than logically: unlike a relation, these are
 * not a statement about two items that was once true. They are the summary's
 * own working, and the revision that did the working keeps its copy in its
 * stored frontmatter.
 */
export function createSummaryRepository(db: Database): SummaryRepository {
  return {
    async replaceForSummary(tx: Tx, summaryItemId, wanted) {
      const t = asTx(tx);
      await t
        .delete(summaryDependencies)
        .where(eq(summaryDependencies.summaryItemId, summaryItemId));
      if (wanted.length === 0) return;
      await t
        .insert(summaryDependencies)
        .values(wanted.map((dependency) => ({ ...dependency, summaryItemId })));
    },

    async listForSummary(workspaceId, summaryItemId) {
      const rows = await db
        .select()
        .from(summaryDependencies)
        .innerJoin(knowledgeItems, eq(knowledgeItems.id, summaryDependencies.summaryItemId))
        .where(
          and(
            eq(summaryDependencies.summaryItemId, summaryItemId),
            // Scoped, like every other read: an id from one workspace must not
            // answer with rows from another.
            eq(knowledgeItems.workspaceId, workspaceId),
          ),
        )
        .orderBy(asc(summaryDependencies.position));
      return rows.map((row) => row.summary_dependencies as SummaryDependencyRecord);
    },

    async staleAmong(workspaceId, itemIds, tx) {
      if (itemIds.length === 0) return new Set<KnowledgeItemId>();
      // The write's own transaction when there is one: the rows it is asking
      // about are ones it has just written and nothing else can see yet.
      const reader = tx ? asTx(tx) : db;
      // One query for a page, because a list of fifty would otherwise be fifty.
      const rows = await reader
        .select({ id: knowledgeItems.id })
        .from(knowledgeItems)
        .where(
          and(
            inArray(knowledgeItems.id, [...itemIds]),
            eq(knowledgeItems.workspaceId, workspaceId),
            isStale(),
          ),
        );
      return new Set(rows.map((row) => row.id as KnowledgeItemId));
    },
  };
}
