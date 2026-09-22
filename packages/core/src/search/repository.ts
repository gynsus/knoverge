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

/** One item as the index holds it, built from the revision that is current. */
export interface SearchDocumentRecord {
  knowledgeItemId: KnowledgeItemId;
  workspaceId: WorkspaceId;
  revisionId: RevisionId;
  language: string;
  title: string;
  body: string;
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
  includeDisputed?: boolean | undefined;
  limit?: number | undefined;
  /** A passage of the body around the match, when the caller wants one. */
  includeSnippets?: boolean | undefined;
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
  revisionId: RevisionId;
  contentHash: string;
  updatedAt: Date;
  /** 0 to 1, from the components below. Comparable only within one search. */
  score: number;
  components: { lexical: number; title: number };
  /** The passage the match was found in, with the terms marked. */
  snippet: string | null;
}

export interface SearchRepository {
  /** Writes or replaces the index row for one item, with its revision. */
  upsert(tx: Tx, document: SearchDocumentRecord): Promise<void>;
  /** Removes the row, for an item that left the index. */
  remove(tx: Tx, itemId: KnowledgeItemId): Promise<void>;
  /** Best first. Filters are applied before ranking, never after. */
  search(query: SearchQuery): Promise<SearchHit[]>;
  /** For `knoverge db reindex`: what the index currently holds. */
  countFor(workspaceId: WorkspaceId): Promise<number>;
  /**
   * The indexed body of each item, for an abstract.
   *
   * The projection already holds the text, so a page of index records costs
   * one query rather than one file read per item.
   */
  bodiesFor(
    workspaceId: WorkspaceId,
    itemIds: readonly KnowledgeItemId[],
  ): Promise<Map<KnowledgeItemId, string>>;
}
