import { z } from 'zod';

import { LanguageTag } from './identity.ts';
import { KnowledgeItemId, RevisionId, WorkspaceId } from './ids.ts';
import { CategoryPath } from './taxonomy.ts';

/**
 * The fixed type set from `docs/KNOWLEDGE_MODEL.md` section 2.
 *
 * `fact`, `decision`, `instruction` and `preference` hold one independently
 * updateable assertion each (rule 15); large source material is a `document`.
 */
export const ItemType = z.enum([
  'fact',
  'decision',
  'instruction',
  'preference',
  'procedure',
  'observation',
  'episode',
  'document',
  'insight',
  'summary',
]);
export type ItemType = z.infer<typeof ItemType>;

/** Deletion is logical: the file leaves the working tree, the history stays. */
export const ItemStatus = z.enum(['draft', 'active', 'superseded', 'archived', 'deleted']);
export type ItemStatus = z.infer<typeof ItemStatus>;

/** Three orthogonal properties rather than one trust value (ADR 0009). */
export const ReviewState = z.enum(['unreviewed', 'agent_reviewed', 'human_reviewed']);
export type ReviewState = z.infer<typeof ReviewState>;

export const EvidenceState = z.enum(['none', 'source_backed', 'corroborated']);
export type EvidenceState = z.infer<typeof EvidenceState>;

export const SourceType = z.enum([
  'human_input',
  'agent_session',
  'web_url',
  'file',
  'attachment',
  'email',
  'git_commit',
  'external_system',
  'other_knowledge_item',
]);
export type SourceType = z.infer<typeof SourceType>;

export const EvidenceRole = z.enum(['primary', 'supporting', 'derived', 'contradicting']);
export type EvidenceRole = z.infer<typeof EvidenceRole>;

/**
 * How one item connects to another.
 *
 * The set is the one the specifications use. `superseded_by` is deliberately
 * absent: it is `supersedes` read from the other end, and storing both
 * directions gives two rows that can disagree.
 */
export const RelationType = z.enum([
  'supersedes',
  'implements',
  'derived_from',
  'contradicts',
  'duplicates',
  'depends_on',
  'relates_to',
]);
export type RelationType = z.infer<typeof RelationType>;

/**
 * The form of a tag that is written down and shown: Unicode composed, runs of
 * whitespace collapsed, trimmed. Case is left alone, because a tag is content
 * and "PostgreSQL" is how somebody wrote it.
 */
export function canonicalTag(tag: string): string {
  return tag.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * Two tags are the same tag when these agree: canonical form, case folded.
 *
 * Composition is the one that is easy to miss. A Cyrillic "й" typed on one
 * keyboard is a single code point and on another is "и" plus a combining
 * breve; they look identical and compare unequal, so without NFC a workspace
 * quietly grows two tags nobody can tell apart.
 */
export function normaliseTag(tag: string): string {
  return canonicalTag(tag).toLocaleLowerCase();
}

/**
 * A tag is content, not an identifier (ADR 0019).
 *
 * It used to be a slug — lower-case Latin letters, digits and hyphens — on the
 * stated grounds that it "appears in paths and queries". It appears in
 * neither: the file path is built from the category path and the item slug,
 * and a query string carries any text. What the restriction did do was stop a
 * Russian item from carrying Russian tags, in a product whose knowledge is
 * explicitly in any language.
 *
 * What is refused: control characters, because they are invisible in every
 * interface that would show the tag; and commas, because the frontmatter, the
 * query string and the interface all use one to separate tags, and a tag that
 * cannot survive its own separator is a tag nobody can round-trip.
 *
 * The schema validates and does not transform. It is also what responses are
 * encoded with, and a transform only runs one way: putting the normalisation
 * here made every response carrying a tag fail to serialise. Canonicalising is
 * the domain's job, through canonicalTag().
 */
export const Tag = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf},]+$/u, 'any script, but no commas and no control characters')
  .refine((value) => canonicalTag(value).length > 0, 'a tag cannot be only whitespace');

/** An instant, or nothing. Written as `null` rather than omitted. */
const Instant = z.iso.datetime({ offset: true });

/**
 * A source, as the file carries it.
 *
 * PostgreSQL is the queryable authority; this is the portable projection of it,
 * and the integrity checker holds the two to each other.
 */
export const FrontmatterSource = z
  .object({
    type: SourceType,
    uri: z.string().max(2048).optional(),
    client: z.string().max(64).optional(),
    session_id: z.string().max(200).optional(),
    external_key: z.string().max(512).optional(),
    content_hash: z.string().max(80).optional(),
    role: EvidenceRole.default('primary'),
  })
  .strict();
export type FrontmatterSource = z.infer<typeof FrontmatterSource>;

export const FrontmatterRelation = z
  .object({
    type: RelationType,
    target: KnowledgeItemId,
    valid_from: Instant.optional(),
    valid_until: Instant.optional(),
  })
  .strict();
export type FrontmatterRelation = z.infer<typeof FrontmatterRelation>;

export const FrontmatterExternal = z
  .object({
    source_system: z.string().min(1).max(64),
    external_key: z.string().min(1).max(512),
  })
  .strict();
export type FrontmatterExternal = z.infer<typeof FrontmatterExternal>;

/**
 * The frontmatter contract from `docs/GIT_REPOSITORY.md` section 3.
 *
 * Strict on purpose: an unknown key is rejected rather than dropped, because
 * dropping one would silently discard whatever a future version — or another
 * implementation — meant by it, and the file is the canonical copy.
 *
 * Every field here is part of the revision. Changing any of them is a new
 * revision and a new commit, metadata-only changes included.
 */
/**
 * How long a slug may be, for a category or an item.
 *
 * Exported as a number because three places need it and they were allowed to
 * disagree: the generator in `packages/git-store` truncated at eighty, this
 * schema refused past sixty-four, and the database column is sixty-four. A
 * title landing between the first two produced a slug the generator made and
 * nothing would accept, and the item could not be recorded at all.
 *
 * The database is the one that cannot be argued with, so this is its number
 * and everything else derives from it.
 */
export const MAX_SLUG_LENGTH = 64;

/**
 * A knowledge item's file name.
 *
 * Its own schema rather than a category's, because the two are different
 * things that happen to look alike — a category slug is a directory name and
 * chains into a path; an item slug is one file name at the end of one. Naming
 * them apart is what stops a change to one silently moving the other.
 */
export const ItemSlug = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SLUG_LENGTH)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lower-case letters, digits and hyphens');
export type ItemSlug = z.infer<typeof ItemSlug>;

export const Frontmatter = z
  .object({
    id: KnowledgeItemId,
    title: z.string().trim().min(1).max(300),
    type: ItemType,
    status: ItemStatus,
    language: LanguageTag,
    /** Slug paths, never ids. The first is the primary category. */
    categories: z.array(CategoryPath).max(20).default([]),
    tags: z.array(Tag).max(50).default([]),
    review: ReviewState,
    evidence: EvidenceState,
    disputed: z.boolean(),
    valid_from: Instant.nullable().default(null),
    valid_until: Instant.nullable().default(null),
    observed_at: Instant.nullable().default(null),
    created_at: Instant,
    updated_at: Instant,
    sources: z.array(FrontmatterSource).max(50).default([]),
    relations: z.array(FrontmatterRelation).max(50).default([]),
    /**
     * What replaced this item, on the item that was replaced.
     *
     * A projection of the one `supersedes` relation, which lives on the new
     * item and in PostgreSQL. Absent means not superseded. See ADR 0015: the
     * relation is recorded once and written twice, so that an old file read on
     * its own says both that it was replaced and by what.
     */
    superseded_by: KnowledgeItemId.nullable().optional(),
    external: FrontmatterExternal.optional(),
    /** Only for `type: summary`: the revisions the summary was made from. */
    summary_of: z
      .array(z.string().regex(/^kn_[0-9A-HJKMNP-TV-Z]{26}@rev_[0-9A-HJKMNP-TV-Z]{26}$/))
      .max(200)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.summary_of && value.type !== 'summary') {
      ctx.addIssue({
        code: 'custom',
        path: ['summary_of'],
        message: 'summary_of belongs to an item of type summary',
      });
    }
  });
export type Frontmatter = z.infer<typeof Frontmatter>;

/**
 * The order keys are written in, from the same section.
 *
 * A fixed order is what makes two renderings of one item the same bytes, so a
 * diff shows what changed rather than how the serialiser felt about it.
 */
export const FRONTMATTER_KEY_ORDER = [
  'id',
  'title',
  'type',
  'status',
  'language',
  'categories',
  'tags',
  'review',
  'evidence',
  'disputed',
  'valid_from',
  'valid_until',
  'observed_at',
  'created_at',
  'updated_at',
  'sources',
  'relations',
  'superseded_by',
  'external',
  'summary_of',
] as const satisfies readonly (keyof Frontmatter)[];

/** A revision as the commit trailers name it: `<item>@<revision> <kind>`. */
export const ChangeKind = z.enum([
  'create',
  'update',
  'move',
  /** Frontmatter changed and the text did not: still a revision, still a commit. */
  'metadata',
  'delete',
  'restore',
  'supersede',
  'superseded_by',
  'import',
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

export interface RevisionRef {
  itemId: KnowledgeItemId;
  revisionId: RevisionId;
  kind: ChangeKind;
}

/** A knowledge item as a list or a detail view shows it. */
export const KnowledgeItemSummary = z.object({
  id: KnowledgeItemId,
  workspace_id: WorkspaceId,
  slug: ItemSlug,
  /** `knowledge/<primary category path>/<slug>.md`, derived and stored. */
  markdown_path: z.string(),
  title: z.string(),
  type: ItemType,
  status: ItemStatus,
  language: LanguageTag,
  current_revision_id: RevisionId,
  review_state: ReviewState,
  evidence_state: EvidenceState,
  disputed: z.boolean(),
  /** Slug paths, primary first, the way the frontmatter carries them. */
  categories: z.array(CategoryPath),
  tags: z.array(Tag),
  valid_from: z.iso.datetime({ offset: true }).nullable(),
  valid_until: z.iso.datetime({ offset: true }).nullable(),
  observed_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type KnowledgeItemSummary = z.infer<typeof KnowledgeItemSummary>;

/** The item with the knowledge itself, which a list deliberately omits. */
export const KnowledgeItemDetail = KnowledgeItemSummary.extend({
  body: z.string(),
  sources: z.array(FrontmatterSource),
  relations: z.array(FrontmatterRelation),
  content_hash: z.string(),
  frontmatter_hash: z.string(),
  revision_number: z.number().int().positive(),
});
export type KnowledgeItemDetail = z.infer<typeof KnowledgeItemDetail>;

export const CreateKnowledgeRequest = z.object({
  title: z.string().trim().min(1).max(300),
  /** The knowledge itself, as Markdown. */
  body: z.string().min(1).max(200_000),
  type: ItemType,
  language: LanguageTag.optional(),
  /**
   * Slug paths. The first is the primary category and decides where the file
   * lives. An item with none is uncategorised and lives under
   * `knowledge/_uncategorised/`.
   */
  categories: z.array(CategoryPath).max(20).default([]),
  tags: z.array(Tag).max(50).default([]),
  /** Chosen from the title unless one is given. */
  slug: ItemSlug.optional(),
  valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
  valid_until: z.iso.datetime({ offset: true }).nullable().optional(),
  observed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  external: FrontmatterExternal.optional(),
  /** Where the knowledge came from. One with a locator makes it source-backed. */
  sources: z.array(FrontmatterSource).max(50).default([]),
  /** How it connects to other items. Replaced whole, like tags. */
  relations: z.array(FrontmatterRelation).max(50).default([]),
  request_id: z.string().max(128).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type CreateKnowledgeRequest = z.infer<typeof CreateKnowledgeRequest>;

/**
 * Replacing one item with another, as one operation.
 *
 * The old item keeps its text and stops being current; the new item says what
 * it replaced. One commit, two revisions, so a half-applied supersession
 * cannot exist (`KNOWLEDGE_LIFECYCLE.md` section 5).
 */
export const SupersedeKnowledgeRequest = z
  .object({
    old_item_id: KnowledgeItemId,
    old_base_revision_id: RevisionId,
    old_base_content_hash: z.string().min(1).max(80),
    /** When the old item stopped being true, and the new one started. */
    valid_until: z.iso.datetime({ offset: true }).optional(),
    new_item: CreateKnowledgeRequest.omit({ request_id: true, idempotency_key: true }).optional(),
    /**
     * An item the workspace already holds, taking over instead. It gets a
     * revision of its own, so it carries the base the caller read: rule 6
     * knows nothing about why an item is being changed.
     */
    existing_item: z
      .object({
        item_id: KnowledgeItemId,
        base_revision_id: RevisionId,
        base_content_hash: z.string().min(1).max(80),
      })
      .optional(),
    request_id: z.string().max(128).optional(),
    idempotency_key: z.string().max(128).optional(),
  })
  .refine((value) => (value.new_item === undefined) !== (value.existing_item === undefined), {
    message: 'give either new_item or existing_item, not both and not neither',
  });
export type SupersedeKnowledgeRequest = z.infer<typeof SupersedeKnowledgeRequest>;

/** Both sides of a supersession, which is one operation with two results. */
export const SupersedeResponse = z.object({
  item: KnowledgeItemDetail,
  superseded: KnowledgeItemDetail,
});
export type SupersedeResponse = z.infer<typeof SupersedeResponse>;

/**
 * Looking for something by what it says.
 *
 * Rule 8: search returns candidates. Every result carries the revision and
 * content hash it was found at, so the caller can fetch the canonical item
 * and see whether it has moved on since.
 */
export const KnowledgeSearchInput = z.object({
  query: z.string().trim().min(1).max(500),
  /** Slug paths; resolved to ids before anything is authorised (rule 13). */
  category_paths: z.array(CategoryPath).max(20).default([]),
  types: z.array(ItemType).max(20).default([]),
  /** Active only by default: what the workspace currently asserts. */
  statuses: z.array(ItemStatus).max(8).default(['active']),
  languages: z.array(LanguageTag).max(8).default([]),
  review_states: z.array(ReviewState).max(4).default([]),
  include_disputed: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(20),
  include_snippets: z.boolean().default(true),
});
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInput>;

/** One candidate, with enough of the item to decide whether to read it. */
export const SearchResult = z.object({
  item_id: KnowledgeItemId,
  title: z.string(),
  type: ItemType,
  status: ItemStatus,
  language: LanguageTag,
  review_state: ReviewState,
  evidence_state: EvidenceState,
  disputed: z.boolean(),
  category_paths: z.array(CategoryPath),
  revision_id: RevisionId,
  content_hash: z.string(),
  updated_at: z.iso.datetime({ offset: true }),
  /** 0 to 1, relative to the best hit of this search and no other. */
  score: z.number(),
  /**
   * Which passage of the item answered, counting from zero.
   *
   * The index is chunked (ADR 0020), so a hit names the part that matched
   * rather than the item as a whole. The snippet is taken from this chunk,
   * and a reader can be shown where in a long document it came from.
   */
  chunk_ordinal: z.number().int().nonnegative(),
  score_components: z.object({ title: z.number(), lexical: z.number() }),
  /** The passage the match was found in, with `<b>` around the terms. */
  snippet: z.string().nullable(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const KnowledgeSearchResponse = z.object({ results: z.array(SearchResult) });
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponse>;

/**
 * Reading one item.
 *
 * Bounded, because a `document` may run to two hundred kilobytes and an agent
 * that asks for one should not lose its context to it. The answer says how
 * much there was and whether this is all of it, so a caller can ask for the
 * rest rather than work from a fragment without knowing.
 */
export const KnowledgeGetInput = z.object({
  item_id: KnowledgeItemId,
  /** A past revision, or the current one when absent. */
  revision_id: RevisionId.nullable().default(null),
  include_provenance: z.boolean().default(true),
  include_relations: z.boolean().default(true),
  max_chars: z.number().int().min(100).max(200_000).default(20_000),
  offset: z.number().int().nonnegative().default(0),
});
export type KnowledgeGetInput = z.infer<typeof KnowledgeGetInput>;

export const KnowledgeHistoryInput = z.object({ item_id: KnowledgeItemId });
export type KnowledgeHistoryInput = z.infer<typeof KnowledgeHistoryInput>;

export const KnowledgeDiffInput = z.object({
  item_id: KnowledgeItemId,
  from_revision_id: RevisionId,
  to_revision_id: RevisionId,
});
export type KnowledgeDiffInput = z.infer<typeof KnowledgeDiffInput>;

export const KnowledgeResponse = z.object({
  item: KnowledgeItemDetail,
  /** The whole body's length, whatever slice of it came back. */
  total_chars: z.number().int().nonnegative(),
  /** True when the body is a slice, so a caller knows to ask for the rest. */
  truncated: z.boolean(),
});
export type KnowledgeResponse = z.infer<typeof KnowledgeResponse>;

/**
 * A page of items, for the browser's list.
 *
 * Coerced from a query string, which carries only strings. The tool for
 * listing at scale is `knowledge_index`; this is what a page of the web
 * interface asks for.
 */
/**
 * Browsing the workspace, as opposed to searching it.
 *
 * The filters are the ones somebody reaches for when they are looking at what
 * is there rather than for a particular thing: the branch, the kind, whether
 * it has been checked. A query is `knowledge_search`, which ranks; this
 * pages, in creation order, and the cursor depends on that order.
 *
 * `category_path` is a path at the boundary and an id underneath (rule 13),
 * and it covers the branch: browsing `architecture` means the architecture, not
 * the handful of items filed at its root.
 */
export const KnowledgeListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The id the previous page ended at; ids sort in creation order. */
  cursor: KnowledgeItemId.optional(),
  category_path: CategoryPath.optional(),
  /** Repeatable: `?types=fact&types=decision`. */
  types: z
    .union([ItemType, z.array(ItemType)])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  review_states: z
    .union([ReviewState, z.array(ReviewState)])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  /** Active by default: what the workspace currently asserts. */
  status: ItemStatus.optional(),
});
export type KnowledgeListQuery = z.infer<typeof KnowledgeListQuery>;

export const KnowledgeListResponse = z.object({
  items: z.array(KnowledgeItemSummary),
  /** The cursor for the next page, or null at the end. */
  next_cursor: z.string().nullable(),
});
export type KnowledgeListResponse = z.infer<typeof KnowledgeListResponse>;

/**
 * Changing an item.
 *
 * `base_revision_id` and `base_content_hash` are what the caller read, and
 * both are required: rule 6 says an update carries what it was based on, and a
 * mismatch is a conflict rather than an overwrite. Every field left out is
 * left alone; `categories` and `tags` replace the whole list when given.
 */
export const UpdateKnowledgeRequest = z.object({
  item_id: KnowledgeItemId,
  base_revision_id: RevisionId,
  base_content_hash: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().min(1).max(200_000).optional(),
  type: ItemType.optional(),
  language: LanguageTag.optional(),
  categories: z.array(CategoryPath).max(20).optional(),
  tags: z.array(Tag).max(50).optional(),
  valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
  valid_until: z.iso.datetime({ offset: true }).nullable().optional(),
  observed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  sources: z.array(FrontmatterSource).max(50).optional(),
  relations: z.array(FrontmatterRelation).max(50).optional(),
  request_id: z.string().max(128).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type UpdateKnowledgeRequest = z.infer<typeof UpdateKnowledgeRequest>;

/**
 * Removing an item from the current index.
 *
 * The file leaves the working tree and the history keeps it, so a delete is a
 * commit like any other and is undone by `knowledge.restore`.
 */
export const DeleteKnowledgeRequest = z.object({
  item_id: KnowledgeItemId,
  base_revision_id: RevisionId,
  base_content_hash: z.string().min(1).max(80),
  request_id: z.string().max(128).optional(),
});
export type DeleteKnowledgeRequest = z.infer<typeof DeleteKnowledgeRequest>;

export const RestoreKnowledgeRequest = z.object({
  item_id: KnowledgeItemId,
  request_id: z.string().max(128).optional(),
});
export type RestoreKnowledgeRequest = z.infer<typeof RestoreKnowledgeRequest>;

/** One revision, as history shows it. */
export const RevisionSummary = z.object({
  id: RevisionId,
  revision_number: z.number().int().positive(),
  change_kind: ChangeKind,
  title: z.string(),
  markdown_path: z.string(),
  content_hash: z.string(),
  frontmatter_hash: z.string(),
  git_commit: z.string(),
  actor_id: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
export type RevisionSummary = z.infer<typeof RevisionSummary>;

export const RevisionsResponse = z.object({ revisions: z.array(RevisionSummary) });
export type RevisionsResponse = z.infer<typeof RevisionsResponse>;

/** One frontmatter field that differs between two revisions. */
export const MetadataChange = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type MetadataChange = z.infer<typeof MetadataChange>;

export const KnowledgeDiffResponse = z.object({
  from: RevisionSummary,
  to: RevisionSummary,
  /** A unified diff of the whole file, empty when the bytes are identical. */
  body_diff: z.string(),
  /**
   * What changed in the frontmatter, field by field.
   *
   * Computed from the two revisions rather than read out of the text diff: a
   * reader asking what changed about an item wants the answer, not a patch to
   * read it out of.
   */
  metadata_changes: z.array(MetadataChange),
});
export type KnowledgeDiffResponse = z.infer<typeof KnowledgeDiffResponse>;

/**
 * The incremental synchronisation primitive.
 *
 * Canonical knowledge changes after a checkpoint, limited to what the caller
 * may read. It names no actors: who did something is the audit feed's
 * question, and a synchronising agent does not need it (ADR 0010).
 */
export const KnowledgeChangesInput = z.object({
  after_sequence: z.number().int().nonnegative().default(0),
  category_paths: z.array(CategoryPath).max(20).default([]),
  types: z.array(ItemType).max(20).default([]),
  limit: z.number().int().min(1).max(500).default(200),
});
export type KnowledgeChangesInput = z.infer<typeof KnowledgeChangesInput>;

export const ChangeKindFeed = z.enum([
  'created',
  'updated',
  'moved',
  'superseded',
  'deleted',
  'restored',
  'relation_changed',
  'taxonomy_changed',
]);
export type ChangeKindFeed = z.infer<typeof ChangeKindFeed>;

export const KnowledgeChange = z.object({
  sequence: z.number().int().positive(),
  change_kind: ChangeKindFeed,
  item_id: z.string(),
  revision_id: z.string().nullable(),
  content_hash: z.string().nullable(),
  frontmatter_hash: z.string().nullable(),
  category_paths_before: z.array(CategoryPath),
  category_paths_after: z.array(CategoryPath),
  taxonomy_version: z.number().int().nonnegative(),
  changed_at: z.iso.datetime({ offset: true }),
});
export type KnowledgeChange = z.infer<typeof KnowledgeChange>;

export const KnowledgeChangesResponse = z.object({
  changes: z.array(KnowledgeChange),
  next_sequence: z.number().int().nonnegative(),
  has_more: z.boolean(),
  /** The taxonomy the workspace is at now, so a client can notice a rename. */
  taxonomy_version: z.number().int().nonnegative(),
});
export type KnowledgeChangesResponse = z.infer<typeof KnowledgeChangesResponse>;

/**
 * Compact index pages, for reconciliation.
 *
 * What an agent reads to decide what it already knows, before proposing
 * anything. One record per item, small enough that a whole workspace fits in
 * a few pages.
 */
export const KnowledgeIndexInput = z.object({
  category_paths: z.array(CategoryPath).max(20).default([]),
  updated_after: z.iso.datetime({ offset: true }).nullable().default(null),
  /** The id the previous page ended at; ids sort in creation order. */
  cursor: KnowledgeItemId.nullable().default(null),
  limit: z.number().int().min(1).max(500).default(200),
});
export type KnowledgeIndexInput = z.infer<typeof KnowledgeIndexInput>;

export const KnowledgeIndexRecord = z.object({
  item_id: KnowledgeItemId,
  title: z.string(),
  type: ItemType,
  category_paths: z.array(CategoryPath),
  status: ItemStatus,
  review_state: ReviewState,
  evidence_state: EvidenceState,
  disputed: z.boolean(),
  language: LanguageTag,
  revision_id: RevisionId,
  content_hash: z.string(),
  source_system: z.string().nullable(),
  external_key: z.string().nullable(),
  updated_at: z.iso.datetime({ offset: true }),
  /** Short on purpose: enough to match against, not enough to work from. */
  abstract: z.string(),
});
export type KnowledgeIndexRecord = z.infer<typeof KnowledgeIndexRecord>;

export const KnowledgeIndexResponse = z.object({
  records: z.array(KnowledgeIndexRecord),
  next_cursor: KnowledgeItemId.nullable(),
  has_more: z.boolean(),
});
export type KnowledgeIndexResponse = z.infer<typeof KnowledgeIndexResponse>;

/**
 * A token-budgeted context pack for a part of the tree.
 *
 * The first substantive call of a working session: what an agent should know
 * before it starts, in an amount it can afford to read.
 */
export const KnowledgeBriefingInput = z.object({
  category_paths: z.array(CategoryPath).max(20).default([]),
  types: z.array(ItemType).max(20).default(['instruction', 'preference', 'decision', 'procedure']),
  include_recent: z.boolean().default(true),
  recent_days: z.number().int().min(1).max(365).default(14),
  max_chars: z.number().int().min(1000).max(200_000).default(24_000),
});
export type KnowledgeBriefingInput = z.infer<typeof KnowledgeBriefingInput>;

export const BriefingSectionKind = z.enum([
  'instructions',
  'preferences',
  'decisions',
  'procedures',
  'recent',
  'open_conflicts',
  'pending_proposals',
]);
export type BriefingSectionKind = z.infer<typeof BriefingSectionKind>;

export const BriefingItem = z.object({
  item_id: z.string(),
  /** Null only for a proposal whose payload retention has emptied it. */
  title: z.string().nullable(),
  type: ItemType.nullable(),
  revision_id: z.string().nullable(),
  content_hash: z.string().nullable(),
  /** Absent in the compact sections, which name items rather than carry them. */
  markdown: z.string().nullable(),
  /** True when only the opening survived the budget. */
  abridged: z.boolean(),
  updated_at: z.iso.datetime({ offset: true }),
});
export type BriefingItem = z.infer<typeof BriefingItem>;

export const KnowledgeBriefingResponse = z.object({
  taxonomy_version: z.number().int().nonnegative(),
  change_sequence: z.number().int().nonnegative(),
  sections: z.array(z.object({ kind: BriefingSectionKind, items: z.array(BriefingItem) })),
  /** True when the budget dropped something, so a caller knows to narrow it. */
  truncated: z.boolean(),
});
export type KnowledgeBriefingResponse = z.infer<typeof KnowledgeBriefingResponse>;
