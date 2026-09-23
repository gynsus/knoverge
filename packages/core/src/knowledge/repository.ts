import type {
  ChangeKind,
  EvidenceState,
  Frontmatter,
  ItemStatus,
  ItemType,
  KnowledgeItemId,
  RevisionId,
  ReviewState,
  WorkspaceId,
  ActorId,
  CategoryId,
  EvidenceRole,
  RelationId,
  RelationType,
  SourceReferenceId,
  SourceType,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/** The current state of one item, as PostgreSQL indexes it. */
export interface KnowledgeItemRecord {
  id: KnowledgeItemId;
  workspaceId: WorkspaceId;
  slug: string;
  /** `knowledge/<primary category path>/<slug>.md`, derived and stored. */
  markdownPath: string;
  type: ItemType;
  status: ItemStatus;
  language: string;
  currentRevisionId: RevisionId | null;
  reviewState: ReviewState;
  evidenceState: EvidenceState;
  disputed: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  observedAt: Date | null;
  sourceSystem: string | null;
  externalKey: string | null;
  createdByActorId: ActorId;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** One commit that touched an item. Immutable once written. */
export interface RevisionRecord {
  id: RevisionId;
  knowledgeItemId: KnowledgeItemId;
  workspaceId: WorkspaceId;
  revisionNumber: number;
  contentHash: string;
  frontmatterHash: string;
  gitCommitHash: string;
  title: string;
  markdownPath: string;
  /** The frontmatter exactly as the file carries it, for rebuilding a row. */
  frontmatter: Frontmatter;
  changeKind: ChangeKind;
  createdByActorId: ActorId;
  createdAt: Date;
  operationId: string;
}

export interface ItemCategoryRecord {
  knowledgeItemId: KnowledgeItemId;
  categoryId: CategoryId;
  isPrimary: boolean;
  position: number;
}

export interface ListItemsOptions {
  /** Items in this category, and optionally its descendants. */
  categoryId?: CategoryId;
  /** Any of these categories, for a subtree already resolved to ids. */
  categoryIds?: readonly CategoryId[];
  includeDescendants?: boolean;
  status?: ItemStatus;
  types?: readonly ItemType[];
  /** Only items in these review states, for the queue of what nobody checked. */
  reviewStates?: readonly ReviewState[];
  /** Only items the workspace marks as contested. */
  disputed?: boolean;
  updatedAfter?: Date;
  limit?: number;
  /** The id the previous page ended at; ids sort in creation order. */
  after?: KnowledgeItemId;
  /**
   * `created` is the paging order, because ids sort that way and a cursor
   * over them neither repeats nor skips. `updated` is for a caller that wants
   * the newest few and will not page: taking a page in creation order and
   * then sorting it by recency answers with the oldest items in the
   * workspace, whatever the caller asked for.
   */
  orderBy?: 'created' | 'updated';
}

export interface KnowledgeRepository {
  insert(tx: Tx, item: KnowledgeItemRecord): Promise<void>;
  /**
   * Updates the columns a new revision changes. The revision itself is what
   * records the change; this is the index catching up to it.
   */
  update(
    tx: Tx,
    id: KnowledgeItemId,
    patch: Partial<
      Pick<
        KnowledgeItemRecord,
        | 'slug'
        | 'markdownPath'
        | 'status'
        | 'language'
        | 'currentRevisionId'
        | 'reviewState'
        | 'evidenceState'
        | 'disputed'
        | 'validFrom'
        | 'validUntil'
        | 'observedAt'
        | 'updatedAt'
        | 'deletedAt'
      >
    >,
  ): Promise<void>;
  findById(
    workspaceId: WorkspaceId,
    id: KnowledgeItemId,
    tx?: Tx,
  ): Promise<KnowledgeItemRecord | null>;
  /** Whether anything already occupies this file path in the workspace. */
  findByPath(
    workspaceId: WorkspaceId,
    markdownPath: string,
    tx?: Tx,
  ): Promise<KnowledgeItemRecord | null>;
  list(workspaceId: WorkspaceId, options?: ListItemsOptions): Promise<KnowledgeItemRecord[]>;
  /**
   * Every item whose file sits under a directory, itself or nested.
   *
   * What a taxonomy change needs when a category path moves: the files under
   * the old path are exactly the knowledge that has to travel with it.
   */
  pathsUnderDirectory(
    workspaceId: WorkspaceId,
    directory: string,
    tx?: Tx,
  ): Promise<{ id: KnowledgeItemId; slug: string; markdownPath: string }[]>;
  /** The slugs already used in one directory, so a new one can avoid them. */
  slugsInDirectory(workspaceId: WorkspaceId, directory: string, tx?: Tx): Promise<string[]>;

  setCategories(tx: Tx, itemId: KnowledgeItemId, rows: ItemCategoryRecord[]): Promise<void>;
  categoriesOf(
    workspaceId: WorkspaceId,
    itemIds: readonly KnowledgeItemId[],
  ): Promise<ItemCategoryRecord[]>;

  /** Creates any tag that does not exist yet and attaches exactly this set. */
  setTags(
    tx: Tx,
    workspaceId: WorkspaceId,
    itemId: KnowledgeItemId,
    tags: readonly string[],
  ): Promise<void>;
  tagsOf(
    workspaceId: WorkspaceId,
    itemIds: readonly KnowledgeItemId[],
  ): Promise<Map<KnowledgeItemId, string[]>>;

  /**
   * The current title of each item, for a list that has to name them.
   *
   * The title lives on the revision, so a caller holding item ids alone
   * cannot say what they are without this.
   */
  titlesOf(
    workspaceId: WorkspaceId,
    itemIds: readonly KnowledgeItemId[],
  ): Promise<Map<KnowledgeItemId, string>>;

  /** How many items the workspace holds, for a manifest. */
  countFor(workspaceId: WorkspaceId): Promise<number>;

  /** The item already recorded under this external identity, if any. */
  findByExternal(
    workspaceId: WorkspaceId,
    sourceSystem: string,
    externalKey: string,
  ): Promise<KnowledgeItemRecord | null>;
  /** Active items whose current revision holds exactly this content hash. */
  findByContentHash(workspaceId: WorkspaceId, contentHash: string): Promise<DuplicateRow[]>;
  /**
   * Active items whose current title is close to this one.
   *
   * Trigram similarity, which is what `pg_trgm` is installed for. Ordered by
   * score, best first.
   */
  findSimilarTitles(
    workspaceId: WorkspaceId,
    title: string,
    threshold: number,
    limit: number,
  ): Promise<DuplicateRow[]>;
}

/** An item a duplicate check found, with what it takes to judge the match. */
export interface DuplicateRow {
  itemId: KnowledgeItemId;
  title: string;
  markdownPath: string;
  type: ItemType;
  /** The category the file lives under, or null for an uncategorised item. */
  primaryCategoryId: CategoryId | null;
  /** 0 to 1 for a lexical match; null when the match was exact. */
  score: number | null;
}

export interface RevisionRepository {
  insert(tx: Tx, revision: RevisionRecord): Promise<void>;
  findById(workspaceId: WorkspaceId, id: RevisionId, tx?: Tx): Promise<RevisionRecord | null>;
  /**
   * Several revisions at once, for a page of items.
   *
   * A list of fifty items needs fifty titles, and asking for them one at a
   * time is fifty round trips to draw one screen.
   */
  findManyByIds(workspaceId: WorkspaceId, ids: readonly RevisionId[]): Promise<RevisionRecord[]>;
  /** Newest first. */
  listForItem(itemId: KnowledgeItemId, limit?: number): Promise<RevisionRecord[]>;
  /**
   * The newest commit any revision in this workspace was written with.
   *
   * Used before writing: a repository that does not contain it is not the
   * repository this workspace's history belongs to.
   */
  latestCommit(workspaceId: WorkspaceId, tx?: Tx): Promise<string | null>;
}

/** A source the knowledge rests on, deduplicated per workspace. */
export interface SourceRecord {
  id: SourceReferenceId;
  workspaceId: WorkspaceId;
  sourceType: SourceType;
  uri: string | null;
  externalSystem: string | null;
  externalKey: string | null;
  attachmentId: string | null;
  sourceModifiedAt: Date | null;
  /** The raw source's fingerprint, not the knowledge content hash. */
  sourceContentHash: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface RevisionSourceRecord {
  revisionId: RevisionId;
  sourceReferenceId: SourceReferenceId;
  evidenceRole: EvidenceRole;
  position: number;
}

export interface RelationRecord {
  id: RelationId;
  workspaceId: WorkspaceId;
  fromItemId: KnowledgeItemId;
  relationType: RelationType;
  toItemId: KnowledgeItemId;
  validFrom: Date | null;
  validUntil: Date | null;
  createdByActorId: ActorId;
  createdAt: Date;
  removedAt: Date | null;
}

export interface SourceRepository {
  /**
   * Finds or creates the sources, in order, and returns their ids.
   *
   * Deduplicated by whatever identifies a source — its URI, or its record in
   * another system — so citing the same page from ten items is one row and the
   * graph of what rests on what stays readable.
   */
  ensure(
    tx: Tx,
    workspaceId: WorkspaceId,
    sources: readonly Omit<SourceRecord, 'id' | 'workspaceId' | 'createdAt'>[],
    at: Date,
  ): Promise<SourceReferenceId[]>;
  attachToRevision(tx: Tx, rows: readonly RevisionSourceRecord[]): Promise<void>;
  /** The sources a revision rested on, in the order it listed them. */
  forRevision(revisionId: RevisionId): Promise<(SourceRecord & { role: EvidenceRole })[]>;
}

export interface RelationRepository {
  /**
   * Makes the live relations of an item exactly this set: anything missing is
   * removed logically, anything new is added, and what is unchanged is left
   * alone so its creation time survives.
   */
  replaceForItem(
    tx: Tx,
    workspaceId: WorkspaceId,
    fromItemId: KnowledgeItemId,
    wanted: readonly Omit<
      RelationRecord,
      'id' | 'workspaceId' | 'fromItemId' | 'createdAt' | 'removedAt'
    >[],
    at: Date,
  ): Promise<void>;
  /** The live relations an item points at. */
  listForItem(workspaceId: WorkspaceId, fromItemId: KnowledgeItemId): Promise<RelationRecord[]>;
  /** The live relations pointing at an item, which is the other direction. */
  listPointingAt(workspaceId: WorkspaceId, toItemId: KnowledgeItemId): Promise<RelationRecord[]>;
}
