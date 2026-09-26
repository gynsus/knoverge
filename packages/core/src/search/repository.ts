import type {
  EvidenceState,
  ItemStatus,
  ItemType,
  KnowledgeItemId,
  ReviewState,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/** One piece of an item's body, as the index holds it. */
export interface SearchChunkRecord {
  ordinal: number;
  text: string;
}

/**
 * One item as the index holds it, built from the revision that is current.
 *
 * The chunks arrive already split: how text becomes chunks is a decision about
 * retrieval and lives in `@knoverge/search`, not in the repository that writes
 * the rows (ADR 0020).
 */
export interface SearchDocumentRecord {
  knowledgeItemId: KnowledgeItemId;
  workspaceId: WorkspaceId;
  revisionId: RevisionId;
  language: string;
  title: string;
  chunks: readonly SearchChunkRecord[];
  updatedAt: Date;
}

/** What a caller is looking for, and what it is willing to look at. */
export interface SearchQuery {
  workspaceId: WorkspaceId;
  text: string;
  /** Resolved ids, because a path is not a security identifier (rule 13). */
  categoryIds?: readonly string[] | undefined;
  types?: readonly ItemType[] | undefined;
  statuses?: readonly ItemStatus[] | undefined;
  languages?: readonly string[] | undefined;
  /** The workspace's own language, when the caller named none. */
  defaultLanguage?: string | undefined;
  reviewStates?: readonly ReviewState[] | undefined;
  /** What the item's claim rests on: `none` is the pile with no sources. */
  evidenceStates?: readonly EvidenceState[] | undefined;
  includeDisputed?: boolean | undefined;
  limit?: number | undefined;
  /** A passage of the body around the match, when the caller wants one. */
  includeSnippets?: boolean | undefined;
}

/**
 * One chunk that answered, before the two opinions are put together.
 *
 * Chunk-level rather than item-level: fusing has to compare passages, and
 * folding to items before it would throw away the thing being compared.
 */
export interface SearchCandidate extends SearchHit {
  chunkId: string;
}

/** One result, with enough of the item to decide whether to read it. */
export interface SearchHit {
  itemId: KnowledgeItemId;
  title: string;
  type: ItemType;
  status: ItemStatus;
  language: string;
  reviewState: ReviewState;
  evidenceState: EvidenceState;
  disputed: boolean;
  /** Whether a summary is out of step with what it summarises (ADR 0024). */
  stale: boolean;
  revisionId: RevisionId;
  contentHash: string;
  updatedAt: Date;
  markdownPath: string;
  /** 0 to 1, from the components below. Comparable only within one search. */
  score: number;
  /**
   * What each ranking thought, before they were fused.
   *
   * `lexical` is `ts_rank_cd`, which has no ceiling; `semantic` is cosine
   * similarity, which is bounded; `title` is the title's share of the lexical
   * one. Null means that ranking did not find this chunk at all.
   */
  components: { lexical: number; title: number; semantic: number | null };
  /**
   * Which chunk of the item answered, so a snippet is the part that matched
   * rather than the opening of a long document.
   */
  chunkOrdinal: number;
  /** The passage the match was found in, with the terms marked. */
  snippet: string | null;
}

export interface SearchRepository {
  /**
   * Chunks whose text matches, best first.
   *
   * Exact and brittle: it finds the words or it does not. The score it carries
   * is `ts_rank_cd`, which has no ceiling and moves with the corpus, so it is
   * a position in this list and nothing more.
   */
  lexical(query: SearchQuery, limit: number): Promise<SearchCandidate[]>;
  /**
   * Chunks whose meaning is nearest, closest first.
   *
   * Approximate and never empty: it always has an opinion, including when it
   * has no business having one. That is why the two are fused by position.
   */
  semantic(
    query: SearchQuery,
    vector: readonly number[],
    profileId: string,
    limit: number,
  ): Promise<SearchCandidate[]>;
  /** Writes or replaces every chunk of one item, with its revision. */
  upsert(tx: Tx, document: SearchDocumentRecord): Promise<void>;
  /** Removes the chunks, for an item that left the index. */
  remove(tx: Tx, itemId: KnowledgeItemId): Promise<void>;
  /** For `knoverge db reindex`: what the index currently holds. */
  countFor(workspaceId: WorkspaceId): Promise<number>;
  /** Which items the index already holds, so startup fills only the gaps. */
  indexedIds(workspaceId: WorkspaceId): Promise<Set<string>>;
  /**
   * The indexed body of each item, for an abstract: its chunks in order,
   * joined back into one text.
   *
   * The projection already holds the text, so a page of abstracts costs one
   * query rather than one file read per item.
   */
  bodiesFor(
    workspaceId: WorkspaceId,
    itemIds: readonly KnowledgeItemId[],
  ): Promise<Map<KnowledgeItemId, string>>;
}
