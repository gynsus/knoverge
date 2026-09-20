import { z } from 'zod';

import { LanguageTag } from './identity.ts';
import { KnowledgeItemId, RevisionId, WorkspaceId } from './ids.ts';
import { CategoryPath, CategorySlug } from './taxonomy.ts';

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

/** A tag: the same shape as a slug, because it appears in paths and queries. */
export const Tag = CategorySlug;

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
  'external',
  'summary_of',
] as const satisfies readonly (keyof Frontmatter)[];

/** A revision as the commit trailers name it: `<item>@<revision> <kind>`. */
export const ChangeKind = z.enum([
  'create',
  'update',
  'delete',
  'restore',
  'move',
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
  slug: CategorySlug,
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
  slug: CategorySlug.optional(),
  valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
  valid_until: z.iso.datetime({ offset: true }).nullable().optional(),
  observed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  external: FrontmatterExternal.optional(),
  request_id: z.string().max(128).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type CreateKnowledgeRequest = z.infer<typeof CreateKnowledgeRequest>;

export const KnowledgeResponse = z.object({ item: KnowledgeItemDetail });
export type KnowledgeResponse = z.infer<typeof KnowledgeResponse>;

export const KnowledgeListResponse = z.object({
  items: z.array(KnowledgeItemSummary),
  /** The cursor for the next page, or null at the end. */
  next_cursor: z.string().nullable(),
});
export type KnowledgeListResponse = z.infer<typeof KnowledgeListResponse>;
