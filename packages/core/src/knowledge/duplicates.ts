import type { CategoryId, ItemType, KnowledgeItemId, WorkspaceId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import type { DuplicateRow, KnowledgeRepository } from './repository.ts';

/**
 * How close two titles have to be before a proposer is asked to look.
 *
 * Trigram similarity, where 1 is identical. PostgreSQL's own default for the
 * `%` operator is 0.3, which is loose enough to pair unrelated short titles.
 * This is deliberately stricter: a check that cries wolf gets acknowledged
 * without being read, and then it protects nothing.
 */
export const TITLE_SIMILARITY_THRESHOLD = 0.6;

/** At most this many lexical candidates, best first. */
export const MAX_LEXICAL_CANDIDATES = 5;

/**
 * How near two passages must be before this calls them possibly the same.
 *
 * Deliberately high. A false positive refuses a write somebody meant to make,
 * and the only way past it is acknowledging a candidate that was never a
 * duplicate — which teaches a proposer to acknowledge everything. A missed
 * one is caught by the same check on approval, and by a reviewer reading the
 * text.
 *
 * It is a starting point rather than a measured value: tuning it needs a
 * corpus, an embedding model and somebody's judgement about pairs, and until
 * all three exist the conservative number is the honest one.
 */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.88;

/** At most this many semantic candidates. */
export const MAX_SEMANTIC_CANDIDATES = 3;

/**
 * Why an item was offered as a possible duplicate.
 *
 * `exact` is the same text in the same place — the same type and the same
 * primary category — and is not a judgement call. `content_hash` is the same
 * text somewhere else, which may well be a different piece of knowledge: the
 * same instruction in two projects is two instructions. `lexical` is a title
 * close enough to be worth reading, and `semantic` is a passage that says
 * something close enough without sharing the words.
 */
export type MatchReason = 'exact' | 'content_hash' | 'lexical' | 'semantic';

export interface DuplicateCandidate {
  itemId: KnowledgeItemId;
  title: string;
  markdownPath: string;
  reason: MatchReason;
  /** 0 to 1 for a lexical match; null when the content hash matched exactly. */
  score: number | null;
}

export interface DuplicateQuery {
  workspaceId: WorkspaceId;
  title: string;
  body: string;
  type: ItemType;
  /** Resolved ids, because a path is not an identity (rule 13). */
  categoryIds: readonly CategoryId[];
  external?: { source_system: string; external_key: string } | undefined;
  /** Candidates the caller has already looked at and decided are distinct. */
  acknowledged?: readonly string[] | undefined;
  /** Whether a close title counts. False on the second look; see below. */
  lexical?: boolean | undefined;
  /**
   * Which of these items the caller may read.
   *
   * A match outside the caller's scope is not a match it hears about: naming
   * one would tell an agent the title and the file path of knowledge it has
   * no permission to read, and a proposer could map a closed branch by
   * guessing titles and reading the refusals (ADR 0017).
   *
   * Absent means every match is visible, which is right for a check run on
   * behalf of somebody whose scope has already been applied.
   */
  readable?: ((itemIds: readonly KnowledgeItemId[]) => Promise<Set<string>>) | undefined;
}

/** One passage that means nearly the same thing, and how near. */
export interface NearestMatch {
  itemId: KnowledgeItemId;
  title: string;
  markdownPath: string;
  /** Cosine similarity, 0 to 1. */
  similarity: number;
}

export interface DuplicateMatcherOptions {
  items: KnowledgeRepository;
  contentHash: (title: string, body: string) => string;
  threshold?: number;
  limit?: number;
  /**
   * Passages nearest to this text, when anything can answer.
   *
   * Absent whenever no embedding provider is configured, which is the default
   * and has to stay a working configuration (rule 9). It is also expected to
   * answer with nothing rather than throw when the provider is unavailable:
   * a write refused because an optional feature was down would make the
   * feature mandatory.
   */
  nearest?: (
    workspaceId: WorkspaceId,
    text: string,
    limit: number,
  ) => Promise<readonly NearestMatch[]>;
  semanticThreshold?: number;
}

/**
 * Stops a newly connected agent from recording what the workspace already
 * knows.
 *
 * The steps are the cheap, synchronous half of the reconciliation matcher
 * (`AGENT_ONBOARDING_AND_RECONCILIATION.md` section 8): external identity,
 * then content hash, then lexical similarity. Semantic similarity needs an
 * embedding profile and arrives with it; rule 9 says the core works without
 * one, and this does.
 *
 * Nothing here decides that two items are the same. It decides that somebody
 * should look, and a caller who has looked says so with
 * `acknowledged_duplicate_ids`, which is recorded on the proposal so that a
 * reviewer sees what the proposer considered and dismissed.
 */
export class DuplicateMatcher {
  private readonly o: DuplicateMatcherOptions;

  constructor(options: DuplicateMatcherOptions) {
    this.o = options;
  }

  /**
   * Throws when the workspace probably already holds this, and answers with
   * what it may hold that the caller cannot see.
   *
   * `DUPLICATE_EXTERNAL_KEY` is final and cannot be acknowledged: two records
   * under one external identity are the same record by definition, and the
   * caller wants an update rather than a second item. `DUPLICATE_SUSPECTED`
   * is a question, and acknowledging it is the answer.
   *
   * Neither is raised for a match the caller cannot read. Acknowledging one
   * means naming it, and an id nobody may see is an id nobody can name, so
   * raising it would leave a proposer permanently stuck with no recourse.
   * They come back instead, and the caller sends the write to review.
   */
  async screen(query: DuplicateQuery): Promise<DuplicateCandidate[]> {
    return this.check(query, { lexical: true });
  }

  /**
   * The same check, narrowed to what still applies when a reviewer is looking.
   *
   * Run again on approval, because a proposal waits: the workspace can gain
   * the item in the meantime, through a direct write or through an identical
   * proposal approved first, and a check that ran once when the proposal was
   * made is a check that no longer holds. A similar title is not re-raised —
   * that is a question for the proposer, and the reviewer is reading the text
   * right now — but the same text in the same place is not something an
   * approval may produce.
   */
  async assertStillDistinct(query: DuplicateQuery): Promise<void> {
    await this.check(query, { lexical: false });
  }

  private async check(
    query: DuplicateQuery,
    options: { lexical: boolean },
  ): Promise<DuplicateCandidate[]> {
    const hidden: DuplicateCandidate[] = [];
    const visible = async (ids: readonly KnowledgeItemId[]): Promise<Set<string>> =>
      query.readable ? await query.readable(ids) : new Set(ids);

    if (query.external) {
      const existing = await this.o.items.findByExternal(
        query.workspaceId,
        query.external.source_system,
        query.external.external_key,
      );
      if (existing) {
        if ((await visible([existing.id])).has(existing.id)) {
          throw new DomainError(
            'DUPLICATE_EXTERNAL_KEY',
            `${query.external.source_system} ${query.external.external_key} is already recorded; update that item instead of recording it twice`,
            { objectIds: { knowledge_item: existing.id } },
          );
        }
        // The key is taken by something the caller may not read. Saying so
        // would name it; refusing without saying so would be a refusal they
        // could never satisfy.
        hidden.push({
          itemId: existing.id,
          title: existing.slug,
          markdownPath: existing.markdownPath,
          reason: 'exact',
          score: null,
        });
      }
    }

    const found = await this.candidates({ ...query, lexical: options.lexical });
    const allowed = await visible(found.map((c) => c.itemId));
    const candidates = found.filter((c) => {
      if (allowed.has(c.itemId)) return true;
      hidden.push(c);
      return false;
    });
    const acknowledged = new Set(query.acknowledged ?? []);
    // An exact match cannot be acknowledged away. Saying "this is not a
    // duplicate" about the same text in the same place is not a judgement
    // anybody should be able to make; the caller wants to change that item.
    const unseen = candidates.filter((c) => c.reason === 'exact' || !acknowledged.has(c.itemId));
    if (unseen.length === 0) return hidden;

    const exact = unseen.find((c) => c.reason === 'exact');
    throw new DomainError(
      'DUPLICATE_SUSPECTED',
      exact
        ? `the workspace already holds this exact text in the same place, as ${exact.markdownPath}; change that item instead`
        : 'the workspace may already hold this; read the candidates and either change one of them or say which you have ruled out',
      {
        duplicates: unseen.map((c) => ({
          item_id: c.itemId,
          title: c.title,
          markdown_path: c.markdownPath,
          match_reason: c.reason,
          score: c.score,
        })),
      },
    );
  }

  /** What the workspace holds that might already be this, best match first. */
  async candidates(query: DuplicateQuery): Promise<DuplicateCandidate[]> {
    const found = new Map<KnowledgeItemId, DuplicateCandidate>();
    const primary = query.categoryIds[0] ?? null;

    for (const row of await this.o.items.findByContentHash(
      query.workspaceId,
      this.o.contentHash(query.title.trim(), query.body.trim()),
    )) {
      const sameScope = row.type === query.type && row.primaryCategoryId === primary;
      found.set(row.itemId, {
        ...toCandidate(row),
        reason: sameScope ? 'exact' : 'content_hash',
        score: null,
      });
    }

    if (query.lexical === false) return [...found.values()];

    // Near in meaning, which is what finds the same decision written in other
    // words. Only when something can answer: with no provider configured
    // there is no call and no cost.
    if (this.o.nearest) {
      const threshold = this.o.semanticThreshold ?? SEMANTIC_SIMILARITY_THRESHOLD;
      const near = await this.o.nearest(
        query.workspaceId,
        `${query.title.trim()}\n\n${query.body.trim()}`,
        MAX_SEMANTIC_CANDIDATES,
      );
      for (const match of near) {
        if (match.similarity < threshold) continue;
        // Anything already found says more than nearness does.
        if (found.has(match.itemId)) continue;
        found.set(match.itemId, {
          itemId: match.itemId,
          title: match.title,
          markdownPath: match.markdownPath,
          reason: 'semantic',
          score: match.similarity,
        });
      }
    }

    for (const row of await this.o.items.findSimilarTitles(
      query.workspaceId,
      query.title.trim(),
      this.o.threshold ?? TITLE_SIMILARITY_THRESHOLD,
      this.o.limit ?? MAX_LEXICAL_CANDIDATES,
    )) {
      // A content-hash match already says more than a similar title does.
      if (found.has(row.itemId)) continue;
      found.set(row.itemId, { ...toCandidate(row), reason: 'lexical', score: row.score });
    }

    return [...found.values()].sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
  }
}

function toCandidate(row: DuplicateRow): Omit<DuplicateCandidate, 'reason' | 'score'> {
  return { itemId: row.itemId, title: row.title, markdownPath: row.markdownPath };
}
