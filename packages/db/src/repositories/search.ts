import type {
  EvidenceState,
  ItemStatus,
  ItemType,
  KnowledgeItemId,
  ReviewState,
  RevisionId,
} from '@knoverge/contracts';
import type {
  SearchDocumentRecord,
  SearchHit,
  SearchQuery,
  SearchRepository,
  Tx,
} from '@knoverge/core';
import { and, count, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import {
  knowledgeItemCategories,
  knowledgeItems,
  knowledgeRevisions,
} from '../schema/knowledge.ts';
import { searchDocuments } from '../schema/search.ts';
import { asTx } from '../unit-of-work.ts';

/** How many words of body a snippet may run to. */
const SNIPPET_WORDS = 35;

/**
 * What each weight is worth, as `ts_rank_cd` takes them: D, C, B, A.
 *
 * The title is weighted A and the body B, so an item titled "Incident
 * escalation" comes above a long document that merely mentions the words. The
 * ratio is what matters rather than the numbers: a score is comparable only
 * within one search, and it is normalised against that search's best hit
 * before it leaves here.
 */
const WEIGHTS = '{0.1, 0.2, 0.4, 1.0}';

/** Only the title's contribution, for the score component of that name. */
const TITLE_ONLY = '{0, 0, 0, 1.0}';

/** An exact-word match counts, and counts for less than a stemmed one. */
const SIMPLE_WEIGHT = 0.5;

export function createSearchRepository(db: Database): SearchRepository {
  return {
    async upsert(tx: Tx, document: SearchDocumentRecord) {
      await asTx(tx)
        .insert(searchDocuments)
        .values(document)
        .onConflictDoUpdate({
          target: searchDocuments.knowledgeItemId,
          set: {
            revisionId: document.revisionId,
            language: document.language,
            title: document.title,
            body: document.body,
            updatedAt: document.updatedAt,
          },
        });
    },

    async remove(tx: Tx, itemId: KnowledgeItemId) {
      await asTx(tx).delete(searchDocuments).where(eq(searchDocuments.knowledgeItemId, itemId));
    },

    async countFor(workspaceId) {
      const rows = await db
        .select({ total: count() })
        .from(searchDocuments)
        .where(eq(searchDocuments.workspaceId, workspaceId));
      return rows[0]?.total ?? 0;
    },

    async indexedIds(workspaceId) {
      const rows = await db
        .select({ id: searchDocuments.knowledgeItemId })
        .from(searchDocuments)
        .where(eq(searchDocuments.workspaceId, workspaceId));
      return new Set(rows.map((row) => row.id));
    },

    async bodiesFor(workspaceId, itemIds) {
      const result = new Map<KnowledgeItemId, string>();
      if (itemIds.length === 0) return result;
      const rows = await db
        .select({ id: searchDocuments.knowledgeItemId, body: searchDocuments.body })
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, workspaceId),
            inArray(searchDocuments.knowledgeItemId, [...itemIds]),
          ),
        );
      for (const row of rows) result.set(row.id as KnowledgeItemId, row.body);
      return result;
    },

    async search(query: SearchQuery): Promise<SearchHit[]> {
      const text = query.text.trim();
      if (text === '') return [];

      const language = query.languages?.[0] ?? query.defaultLanguage ?? 'simple';
      // The query is parsed twice. The language one matches inflected forms in
      // the language the caller named, or the workspace's own. The simple one
      // matches the exact word whatever language either side is in, which is
      // the only thing that finds a Russian item from a workspace whose
      // default is English.
      //
      // `websearch_to_tsquery` takes what a person types — quoted phrases, a
      // leading minus — rather than requiring an operator expression. A query
      // that parses to nothing matches nothing, which is the right answer.
      const tsquery = sql`websearch_to_tsquery(${configFor(language)}, unaccent(${text}))`;
      const simpleQuery = sql`websearch_to_tsquery('simple', unaccent(${text}))`;
      const rank = sql<number>`
        ts_rank_cd(${WEIGHTS}::float4[], ${searchDocuments.documentTsv}, ${tsquery})
        + ${SIMPLE_WEIGHT}
          * ts_rank_cd(${WEIGHTS}::float4[], ${searchDocuments.simpleTsv}, ${simpleQuery})`;

      const where = [
        eq(searchDocuments.workspaceId, query.workspaceId),
        sql`(${searchDocuments.documentTsv} @@ ${tsquery}
             OR ${searchDocuments.simpleTsv} @@ ${simpleQuery})`,
      ];
      // Filters narrow what is ranked, never what a ranking produced: filtering
      // afterwards would return fewer than the limit for no stated reason.
      if (query.types?.length) where.push(inArray(knowledgeItems.type, [...query.types]));
      if (query.statuses?.length) where.push(inArray(knowledgeItems.status, [...query.statuses]));
      if (query.languages?.length) {
        where.push(inArray(searchDocuments.language, [...query.languages]));
      }
      if (query.reviewStates?.length) {
        where.push(inArray(knowledgeItems.reviewState, [...query.reviewStates]));
      }
      if (query.includeDisputed === false) where.push(eq(knowledgeItems.disputed, false));
      if (query.categoryIds?.length) {
        const ids = db
          .select({ id: knowledgeItemCategories.knowledgeItemId })
          .from(knowledgeItemCategories)
          .where(inArray(knowledgeItemCategories.categoryId, [...query.categoryIds]));
        where.push(inArray(knowledgeItems.id, ids));
      }

      const rows = await db
        .select({
          itemId: searchDocuments.knowledgeItemId,
          title: searchDocuments.title,
          language: searchDocuments.language,
          updatedAt: searchDocuments.updatedAt,
          type: knowledgeItems.type,
          status: knowledgeItems.status,
          reviewState: knowledgeItems.reviewState,
          evidenceState: knowledgeItems.evidenceState,
          disputed: knowledgeItems.disputed,
          revisionId: knowledgeRevisions.id,
          contentHash: knowledgeRevisions.contentHash,
          score: rank,
          titleScore: sql<number>`ts_rank_cd(
            ${TITLE_ONLY}::float4[], ${searchDocuments.documentTsv}, ${tsquery})`,
          // Built from the unstemmed query, so a hit the language query did
          // not make still gets a passage: `ts_headline` marks nothing when
          // the query it is given does not match the text it is given.
          snippet: query.includeSnippets
            ? sql<string>`ts_headline(
                'simple',
                ${searchDocuments.body},
                ${simpleQuery},
                ${`MaxWords=${SNIPPET_WORDS}, MinWords=10, ShortWord=2, MaxFragments=1`}
              )`
            : sql<string | null>`null`,
        })
        .from(searchDocuments)
        .innerJoin(knowledgeItems, eq(knowledgeItems.id, searchDocuments.knowledgeItemId))
        .innerJoin(knowledgeRevisions, eq(knowledgeRevisions.id, searchDocuments.revisionId))
        .where(and(...where))
        .orderBy(sql`${rank} DESC`)
        .limit(Math.min(query.limit ?? 20, 100));

      // The best score in this result set is 1 and the rest are relative to
      // it. `ts_rank_cd` has no ceiling, so an absolute number would mean
      // nothing to a caller and would move as the corpus grew.
      const best = Math.max(...rows.map((r) => Number(r.score)), Number.EPSILON);
      return rows.map((row) => ({
        itemId: row.itemId as KnowledgeItemId,
        title: row.title,
        type: row.type as ItemType,
        status: row.status as ItemStatus,
        language: row.language,
        reviewState: row.reviewState as ReviewState,
        evidenceState: row.evidenceState as EvidenceState,
        disputed: row.disputed,
        revisionId: row.revisionId as RevisionId,
        contentHash: row.contentHash,
        updatedAt: row.updatedAt,
        score: Number(row.score) / best,
        components: { lexical: Number(row.score), title: Number(row.titleScore) },
        snippet: row.snippet ?? null,
      }));
    },
  };
}

/**
 * The text search configuration for a language tag.
 *
 * The same mapping `knoverge_tsvector` uses, so a query is parsed the way the
 * document was indexed. Anything else would stem the query one way and the
 * text another, and the two would never meet.
 */
function configFor(language: string): string {
  switch (language) {
    case 'en':
      return 'english';
    case 'ru':
      return 'russian';
    case 'de':
      return 'german';
    case 'fr':
      return 'french';
    case 'es':
      return 'spanish';
    case 'it':
      return 'italian';
    case 'pt':
      return 'portuguese';
    case 'nl':
      return 'dutch';
    default:
      return 'simple';
  }
}
