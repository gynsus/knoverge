import type {
  ActorId,
  Frontmatter,
  FrontmatterRelation,
  FrontmatterSource,
  ItemType,
  KnowledgeItemId,
  ProposalId,
  ReviewState,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { CategoryRepository } from '../taxonomy/repository.ts';
import type { Clock } from '../ports/clock.ts';
import type { GitStore } from '../ports/git-store.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { CrossStoreWriter } from '../operations/service.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { SearchRepository } from '../search/repository.ts';
import type { TaxonomyVersionRepository } from '../taxonomy/repository.ts';
import type {
  KnowledgeItemRecord,
  KnowledgeRepository,
  RelationRepository,
  RevisionRecord,
  RevisionRepository,
  SourceRepository,
  SummaryRepository,
} from './repository.ts';

/**
 * The vocabulary of a knowledge write: what a caller asks for, and what comes
 * back. Apart from the service so that reading either one is not reading both.
 */

export interface ActorLookup {
  findById(
    workspaceId: WorkspaceId,
    actorId: ActorId,
  ): Promise<{ id: ActorId; displayName: string | null } | null>;
}

export interface WorkspaceLookup {
  findById(
    workspaceId: WorkspaceId,
  ): Promise<{ id: WorkspaceId; name: string; defaultLanguage: string } | null>;
}

export interface KnowledgeServiceOptions {
  uow: UnitOfWork;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  sources: SourceRepository;
  relations: RelationRepository;
  summaries: SummaryRepository;
  /** The lexical index, written with the revision it describes. */
  search: SearchRepository;
  categories: CategoryRepository;
  versions: TaxonomyVersionRepository;
  actors: ActorLookup;
  workspaces: WorkspaceLookup;
  ledger: EventLedger;
  crossStore: CrossStoreWriter;
  git: GitStore;
  /** Turns a title into a slug, and content into its hash. */
  slugifyTitle: (title: string) => string;
  uniqueSlug: (slug: string, taken: ReadonlySet<string>) => string;
  renderItem: (item: { frontmatter: Frontmatter; body: string }) => string;
  parseItem: (text: string) => { frontmatter: Frontmatter; body: string };
  contentHash: (title: string, body: string) => string;
  frontmatterHash: (yaml: string) => string;
  clock?: Clock;
}

export interface DeleteItemInput {
  itemId: KnowledgeItemId;
  baseRevisionId: RevisionId;
  baseContentHash: string;
  /** See `CreateItemInput`: the proposal this write applies. */
  proposalId?: ProposalId | undefined;
  /**
   * Why the change is being made, in the caller's own words.
   *
   * Kept on the revision and written into the commit body, which is where
   * Git has always held the reason for a change. Never in the frontmatter:
   * that describes the item, and a reason folded into the content hash would
   * make every revision differ from itself.
   */
  reason?: string | undefined;
}

export interface UpdateItemInput {
  itemId: KnowledgeItemId;
  /** What the caller read. A mismatch is a conflict, never an overwrite. */
  baseRevisionId: RevisionId;
  baseContentHash: string;
  title?: string | undefined;
  body?: string | undefined;
  type?: ItemType | undefined;
  language?: string | undefined;
  /** Replaces the whole list when given; the first is still primary. */
  categories?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  observedAt?: string | null | undefined;
  sources?: readonly FrontmatterSource[] | undefined;
  relations?: readonly FrontmatterRelation[] | undefined;
  /** See `CreateItemInput`. Replaces the whole list when given. */
  summaryOf?: readonly string[] | undefined;
  /** See `CreateItemInput`: the proposal this write applies. */
  proposalId?: ProposalId | undefined;
  /** See `CreateItemInput`: set only by the review workflow. */
  review?: ReviewState | undefined;
  /**
   * Why the change is being made, in the caller's own words.
   *
   * Kept on the revision and written into the commit body, which is where
   * Git has always held the reason for a change. Never in the frontmatter:
   * that describes the item, and a reason folded into the content hash would
   * make every revision differ from itself.
   */
  reason?: string | undefined;
}

export interface CreateItemInput {
  title: string;
  body: string;
  type: ItemType;
  language?: string | undefined;
  /** Slug paths. The first is primary and decides where the file lives. */
  categories?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  slug?: string | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  observedAt?: string | null | undefined;
  external?: { source_system: string; external_key: string } | undefined;
  sources?: readonly FrontmatterSource[] | undefined;
  relations?: readonly FrontmatterRelation[] | undefined;
  /**
   * Only for `type: summary`: what it was made from, as `<item>@<revision>`.
   *
   * The revision, not just the item, because a summary goes stale when one of
   * them moves on and that is how anybody knows to look at it again (ADR 0024).
   */
  summaryOf?: readonly string[] | undefined;
  /**
   * The proposal this write applies, recorded on the commit so the repository
   * alone says which decision produced the file.
   */
  proposalId?: ProposalId | undefined;
  /**
   * Set only by the review workflow, which knows who approved. A direct write
   * leaves it out and the actor decides: a person reviews as they write, an
   * agent does not.
   */
  review?: ReviewState | undefined;
  /**
   * Why the change is being made, in the caller's own words.
   *
   * Kept on the revision and written into the commit body, which is where
   * Git has always held the reason for a change. Never in the frontmatter:
   * that describes the item, and a reason folded into the content hash would
   * make every revision differ from itself.
   */
  reason?: string | undefined;
}

/** An item that already exists, taking over from the one being superseded. */
export interface ExistingReplacement {
  itemId: KnowledgeItemId;
  /** Rule 6: it gets a new revision, so it carries what the caller read. */
  baseRevisionId: RevisionId;
  baseContentHash: string;
}

/**
 * Replacing one item with another.
 *
 * Exactly one of `newItem` and `existingItem`: the replacement is written now,
 * or it is something the workspace already holds and the supersession only
 * connects the two.
 */
export interface SupersedeInput {
  oldItemId: KnowledgeItemId;
  oldBaseRevisionId: RevisionId;
  oldBaseContentHash: string;
  /** When the old item stopped being true. Now, when nobody says otherwise. */
  validUntil?: string | null | undefined;
  newItem?: CreateItemInput | undefined;
  existingItem?: ExistingReplacement | undefined;
  proposalId?: ProposalId | undefined;
  review?: ReviewState | undefined;
  /**
   * Why the change is being made, in the caller's own words.
   *
   * Kept on the revision and written into the commit body, which is where
   * Git has always held the reason for a change. Never in the frontmatter:
   * that describes the item, and a reason folded into the content hash would
   * make every revision differ from itself.
   */
  reason?: string | undefined;
}

/** Both sides of a supersession, which is one operation with two results. */
export interface SupersedeResult {
  old: ItemResult;
  new: ItemResult;
}

/** An item as a list shows it: everything but the knowledge itself. */
export interface ItemSummary {
  item: KnowledgeItemRecord;
  title: string;
  /** From the current revision, which the list already fetches for the title. */
  revisionNumber: number;
  categories: string[];
  tags: string[];
  /**
   * Whether this is a summary out of step with what it summarises.
   *
   * Computed, never stored (ADR 0024). False for everything that is not a
   * summary: an item with no dependencies cannot be out of step with them.
   */
  stale: boolean;
}

export interface ItemResult {
  item: KnowledgeItemRecord;
  revision: RevisionRecord;
  categories: string[];
  tags: string[];
  body: string;
  /**
   * Whether this is a summary out of step with what it summarises.
   *
   * Always answered, including by a write: naming an old revision is a thing a
   * caller may legitimately do — you summarise what you read, and it may have
   * moved on while you were writing — so a write cannot assume otherwise
   * (ADR 0024).
   */
  stale: boolean;
}
