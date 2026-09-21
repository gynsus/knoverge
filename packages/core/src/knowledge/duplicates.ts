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
 * Why an item was offered as a possible duplicate.
 *
 * `exact` is the same text in the same place — the same type and the same
 * primary category — and is not a judgement call. `content_hash` is the same
 * text somewhere else, which may well be a different piece of knowledge: the
 * same instruction in two projects is two instructions. `lexical` is a title
 * close enough to be worth reading.
 */
export type MatchReason = 'exact' | 'content_hash' | 'lexical';

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
}

export interface DuplicateMatcherOptions {
  items: KnowledgeRepository;
  contentHash: (title: string, body: string) => string;
  threshold?: number;
  limit?: number;
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
   * Throws when the workspace probably already holds this.
   *
   * `DUPLICATE_EXTERNAL_KEY` is final and cannot be acknowledged: two records
   * under one external identity are the same record by definition, and the
   * caller wants an update rather than a second item. `DUPLICATE_SUSPECTED`
   * is a question, and acknowledging it is the answer.
   */
  async assertNotDuplicate(query: DuplicateQuery): Promise<void> {
    if (query.external) {
      const existing = await this.o.items.findByExternal(
        query.workspaceId,
        query.external.source_system,
        query.external.external_key,
      );
      if (existing) {
        throw new DomainError(
          'DUPLICATE_EXTERNAL_KEY',
          `${query.external.source_system} ${query.external.external_key} is already recorded; update that item instead of recording it twice`,
          { objectIds: { knowledge_item: existing.id } },
        );
      }
    }

    const candidates = await this.candidates(query);
    const acknowledged = new Set(query.acknowledged ?? []);
    // An exact match cannot be acknowledged away. Saying "this is not a
    // duplicate" about the same text in the same place is not a judgement
    // anybody should be able to make; the caller wants to change that item.
    const unseen = candidates.filter((c) => c.reason === 'exact' || !acknowledged.has(c.itemId));
    if (unseen.length === 0) return;

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
