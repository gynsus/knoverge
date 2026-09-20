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
  includeDescendants?: boolean;
  status?: ItemStatus;
  limit?: number;
  /** The id the previous page ended at; ids sort in creation order. */
  after?: KnowledgeItemId;
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
}

export interface RevisionRepository {
  insert(tx: Tx, revision: RevisionRecord): Promise<void>;
  findById(workspaceId: WorkspaceId, id: RevisionId, tx?: Tx): Promise<RevisionRecord | null>;
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
