import type {
  EvidenceState,
  ItemStatus,
  ItemType,
  KnowledgeItemId,
  ReviewState,
  RevisionId,
} from '@knoverge/contracts';
import type {
  SearchCandidate,
  SearchDocumentRecord,
  SearchQuery,
  SearchRepository,
  Tx,
} from '@knoverge/core';
import { newId } from '@knoverge/core';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client.ts';
import {
  knowledgeItemCategories,
  knowledgeItems,
  knowledgeRevisions,
} from '../schema/knowledge.ts';
import { embeddings } from '../schema/embeddings.ts';
import { searchChunks } from '../schema/search.ts';
import { isStale } from './summaries.ts';
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
      const t = asTx(tx);
      // Replaced whole rather than merged: an item that lost a paragraph has
      // fewer chunks than before, and an update that only overwrote the ones
      // it still has would leave the tail of the old text findable.
      await t
        .delete(searchChunks)
        .where(eq(searchChunks.knowledgeItemId, document.knowledgeItemId));
      if (document.chunks.length === 0) return;
      await t.insert(searchChunks).values(
        document.chunks.map((chunk) => ({
          id: newId('chunk'),
          knowledgeItemId: document.knowledgeItemId,
          workspaceId: document.workspaceId,
          revisionId: document.revisionId,
          language: document.language,
          title: document.title,
          ordinal: chunk.ordinal,
          text: chunk.text,
          updatedAt: document.updatedAt,
        })),
      );
    },

    async remove(tx: Tx, itemId: KnowledgeItemId) {
      await asTx(tx).delete(searchChunks).where(eq(searchChunks.knowledgeItemId, itemId));
    },

    async countFor(workspaceId) {
      // Items, not chunks: the caller is reporting how much of the workspace
      // is indexed, and "eleven thousand" for five thousand items is a number
      // nobody asked for.
      const rows = await db
        .select({ total: sql<number>`count(distinct ${searchChunks.knowledgeItemId})` })
        .from(searchChunks)
        .where(eq(searchChunks.workspaceId, workspaceId));
      return Number(rows[0]?.total ?? 0);
    },

    async indexedIds(workspaceId) {
      const rows = await db
        .selectDistinct({ id: searchChunks.knowledgeItemId })
        .from(searchChunks)
        .where(eq(searchChunks.workspaceId, workspaceId));
      return new Set(rows.map((row) => row.id));
    },

    async bodiesFor(workspaceId, itemIds) {
      const result = new Map<KnowledgeItemId, string>();
      if (itemIds.length === 0) return result;
      const rows = await db
        .select({
          id: searchChunks.knowledgeItemId,
          body: sql<string>`string_agg(${searchChunks.text}, E'\n\n' ORDER BY ${searchChunks.ordinal})`,
        })
        .from(searchChunks)
        .where(
          and(
            eq(searchChunks.workspaceId, workspaceId),
            inArray(searchChunks.knowledgeItemId, [...itemIds]),
          ),
        )
        .groupBy(searchChunks.knowledgeItemId);
      for (const row of rows) result.set(row.id as KnowledgeItemId, row.body);
      return result;
    },

    async lexical(query: SearchQuery, limit: number): Promise<SearchCandidate[]> {
      const text = query.text.trim();
      if (text === '') return [];
      const { tsquery, simpleQuery } = queriesFor(query);
      const rank = sql<number>`
        ts_rank_cd(${WEIGHTS}::float4[], ${searchChunks.documentTsv}, ${tsquery})
        + ${SIMPLE_WEIGHT}
          * ts_rank_cd(${WEIGHTS}::float4[], ${searchChunks.simpleTsv}, ${simpleQuery})`;

      const rows = await db
        .select(columns(query, rank, tsquery, simpleQuery))
        .from(searchChunks)
        .innerJoin(knowledgeItems, eq(knowledgeItems.id, searchChunks.knowledgeItemId))
        .innerJoin(knowledgeRevisions, eq(knowledgeRevisions.id, searchChunks.revisionId))
        .where(
          and(
            ...filters(db, query),
            sql`(${searchChunks.documentTsv} @@ ${tsquery}
                 OR ${searchChunks.simpleTsv} @@ ${simpleQuery})`,
          ),
        )
        .orderBy(sql`${rank} DESC`)
        .limit(limit);
      return rows.map(toCandidate);
    },

    async semantic(query, vector, profileId, limit): Promise<SearchCandidate[]> {
      const { tsquery, simpleQuery } = queriesFor(query);
      const literal = `[${vector.join(',')}]`;
      // Cosine distance, which is what a normalised embedding is compared
      // with. Turned into a similarity so the component reads the way the
      // lexical one does: larger is nearer.
      const similarity = sql<number>`1 - (${embeddings.vector} <=> ${literal}::vector)`;

      const rows = await db
        .select(columns(query, similarity, tsquery, simpleQuery))
        .from(searchChunks)
        .innerJoin(embeddings, eq(embeddings.chunkId, searchChunks.id))
        .innerJoin(knowledgeItems, eq(knowledgeItems.id, searchChunks.knowledgeItemId))
        .innerJoin(knowledgeRevisions, eq(knowledgeRevisions.id, searchChunks.revisionId))
        .where(and(...filters(db, query), eq(embeddings.profileId, profileId)))
        .orderBy(sql`${embeddings.vector} <=> ${literal}::vector`)
        .limit(limit);
      // The similarity is what this ranking thought, and it is not a
      // `ts_rank_cd`: putting it in the lexical component would be two
      // different measurements under one name.
      return rows.map((row) => {
        const candidate = toCandidate(row);
        return {
          ...candidate,
          components: { ...candidate.components, lexical: 0, semantic: Number(row.score) },
        };
      });
    },
  };
}

/** The two parsings of the query text, which both rankings carry. */
function queriesFor(query: SearchQuery) {
  const text = query.text.trim();
  const language = query.languages?.[0] ?? query.defaultLanguage ?? 'simple';
  // The language one matches inflected forms in the language the caller named,
  // or the workspace's own. The simple one matches the exact word — an
  // identifier, a product name — whatever language either side is in. Neither
  // crosses languages, which ADR 0020 decides rather than leaves undone.
  //
  // `websearch_to_tsquery` takes what a person types — quoted phrases, a
  // leading minus — rather than requiring an operator expression. A query that
  // parses to nothing matches nothing, which is the right answer.
  return {
    tsquery: sql`websearch_to_tsquery(${configFor(language)}, unaccent(${text}))`,
    simpleQuery: sql`websearch_to_tsquery('simple', unaccent(${text}))`,
  };
}

/**
 * What narrows a search, whichever ranking is asking.
 *
 * Filters narrow what is ranked, never what a ranking produced: filtering
 * afterwards would return fewer than the limit for no stated reason.
 */
function filters(db: Database, query: SearchQuery): SQL[] {
  const where: SQL[] = [eq(searchChunks.workspaceId, query.workspaceId) as SQL];
  if (query.types?.length) where.push(inArray(knowledgeItems.type, [...query.types]) as SQL);
  if (query.statuses?.length) {
    where.push(inArray(knowledgeItems.status, [...query.statuses]) as SQL);
  }
  if (query.languages?.length) {
    where.push(inArray(searchChunks.language, [...query.languages]) as SQL);
  }
  if (query.evidenceStates?.length) {
    where.push(inArray(knowledgeItems.evidenceState, [...query.evidenceStates]) as SQL);
  }
  if (query.reviewStates?.length) {
    where.push(inArray(knowledgeItems.reviewState, [...query.reviewStates]) as SQL);
  }
  if (query.includeDisputed === false) where.push(eq(knowledgeItems.disputed, false) as SQL);
  if (query.categoryIds?.length) {
    const ids = db
      .select({ id: knowledgeItemCategories.knowledgeItemId })
      .from(knowledgeItemCategories)
      .where(inArray(knowledgeItemCategories.categoryId, [...query.categoryIds]));
    where.push(inArray(knowledgeItems.id, ids) as SQL);
  }
  return where;
}

/** The same columns from either ranking, so the two can be compared. */
function columns(query: SearchQuery, score: SQL<number>, tsquery: SQL, simpleQuery: SQL) {
  return {
    chunkId: searchChunks.id,
    itemId: searchChunks.knowledgeItemId,
    markdownPath: knowledgeItems.markdownPath,
    title: searchChunks.title,
    language: searchChunks.language,
    ordinal: searchChunks.ordinal,
    updatedAt: searchChunks.updatedAt,
    type: knowledgeItems.type,
    status: knowledgeItems.status,
    reviewState: knowledgeItems.reviewState,
    evidenceState: knowledgeItems.evidenceState,
    disputed: knowledgeItems.disputed,
    // The same one definition the list and the count use (ADR 0024). A summary
    // is stale whether somebody found it by searching or by browsing, and a
    // badge that appears in one and not the other is a badge nobody trusts.
    stale: isStale(),
    revisionId: knowledgeRevisions.id,
    contentHash: knowledgeRevisions.contentHash,
    score,
    titleScore: sql<number>`ts_rank_cd(
      ${TITLE_ONLY}::float4[], ${searchChunks.documentTsv}, ${tsquery})`,
    // Built from the unstemmed query, so a hit the language query did not make
    // still gets a passage: `ts_headline` marks nothing when the query it is
    // given does not match the text it is given.
    snippet: query.includeSnippets
      ? sql<string>`ts_headline(
          'simple',
          ${searchChunks.text},
          ${simpleQuery},
          ${`MaxWords=${SNIPPET_WORDS}, MinWords=10, ShortWord=2, MaxFragments=1`}
        )`
      : sql<string | null>`null`,
  };
}

function toCandidate(row: {
  chunkId: string;
  itemId: string;
  markdownPath: string;
  title: string;
  language: string;
  ordinal: number;
  updatedAt: Date;
  type: string;
  status: string;
  reviewState: string;
  evidenceState: string;
  disputed: boolean;
  stale: boolean;
  revisionId: string;
  contentHash: string;
  score: number;
  titleScore: number;
  snippet: string | null;
}): SearchCandidate {
  return {
    chunkId: row.chunkId,
    itemId: row.itemId as KnowledgeItemId,
    markdownPath: row.markdownPath,
    title: row.title,
    type: row.type as ItemType,
    status: row.status as ItemStatus,
    language: row.language,
    reviewState: row.reviewState as ReviewState,
    evidenceState: row.evidenceState as EvidenceState,
    disputed: row.disputed,
    stale: row.stale,
    revisionId: row.revisionId as RevisionId,
    contentHash: row.contentHash,
    updatedAt: row.updatedAt,
    // Filled by whoever fuses the two rankings; a position in one list is not
    // a score anybody outside can use.
    score: 0,
    components: {
      lexical: Number(row.score),
      title: Number(row.titleScore),
      semantic: null,
    },
    chunkOrdinal: row.ordinal,
    snippet: row.snippet ?? null,
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
