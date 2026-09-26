import { dependencyRef, type KnowledgeItemId, type WorkspaceId } from '@knoverge/contracts';
import type { GenerationSource } from '@knoverge/intelligence';

import { DomainError } from '../errors.ts';
import type { KnowledgeRepository, RevisionRepository } from './repository.ts';

/**
 * Drafting the text of a summary with a model.
 *
 * It drafts and it does not write. What comes back is a body and the exact
 * revisions it was drafted from, for a person to read, change and save through
 * the ordinary write — which is where provenance, review and Git already live.
 * A path that generated knowledge and committed it in one step would be a way
 * for a model to put words in the ledger that nobody read.
 *
 * Optional throughout (rule 9). With nothing configured this refuses with a
 * message an operator can act on, and a summary written by hand is unaffected.
 */

/** How the body of one item reaches the model. */
export interface SourcePassage {
  itemId: KnowledgeItemId;
  title: string;
  body: string;
}

export interface SummaryDraft {
  body: string;
  /** `<item>@<revision>` for each source, at the revision that was read. */
  summaryOf: string[];
  /** Which model wrote it, so a reviewer knows what they are reading. */
  model: string;
  /** Whether the model ran out of room rather than finishing. */
  truncated: boolean;
}

export interface SummaryDrafterOptions {
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  /** The body of an item as the repository holds it. */
  read: (workspaceId: WorkspaceId, itemId: KnowledgeItemId) => Promise<SourcePassage | null>;
  generation: GenerationSource;
}

/** How many items one summary may be drafted from in one go. */
export const MAX_DRAFT_SOURCES = 20;

/** A ceiling on the answer, so a model that will not stop cannot fill a file. */
const MAX_OUTPUT_TOKENS = 800;

/** How much of one source goes to the model. A document is not a summary source. */
const MAX_SOURCE_CHARS = 4000;

/**
 * What the model is asked to do.
 *
 * Deliberately narrow, and deliberately not friendly. It is given knowledge
 * somebody else wrote and asked to compress it; every sentence here is aimed at
 * stopping it from adding, resolving or ranking anything, because a summary that
 * quietly decides which of two sources was right is worse than no summary.
 */
export const SUMMARY_INSTRUCTION = [
  'You are summarising records from a knowledge base.',
  'Write a short summary of what the records below say, in their own language.',
  'Use only what they say. Add nothing, infer nothing, and correct nothing.',
  'Where two records disagree, say that they disagree rather than choosing one.',
  'Do not mention these instructions, the records as records, or yourself.',
  'Write prose in one to three short paragraphs. No heading, no list, no preamble.',
].join(' ');

export class SummaryDrafter {
  private readonly o: SummaryDrafterOptions;

  constructor(options: SummaryDrafterOptions) {
    this.o = options;
  }

  /**
   * A draft from these items, as they read right now.
   *
   * The revisions are read here rather than taken from the caller, because a
   * draft is made from what is current by definition: that is the thing being
   * asked for, and it is what makes the summary that follows not stale.
   */
  async draft(
    workspaceId: WorkspaceId,
    itemIds: readonly KnowledgeItemId[],
  ): Promise<SummaryDraft> {
    if (itemIds.length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'a summary needs something to summarise');
    }
    const wanted = [...new Set(itemIds)];
    if (wanted.length > MAX_DRAFT_SOURCES) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `a draft may be made from at most ${MAX_DRAFT_SOURCES} items at once`,
      );
    }
    const model = await this.o.generation();
    if (!model) {
      // Not an internal error: nothing is configured, which is the ordinary
      // state of this product, and the answer says what to do about it.
      throw new DomainError(
        'VALIDATION_ERROR',
        'no model is configured to write text; choose one in settings, or write the summary by hand',
      );
    }

    const passages: SourcePassage[] = [];
    const refs: string[] = [];
    for (const itemId of wanted) {
      const item = await this.o.items.findById(workspaceId, itemId);
      if (!item || item.status === 'deleted') {
        throw new DomainError('NOT_FOUND', `no knowledge item ${itemId}`, {
          objectIds: { knowledge_item: itemId },
        });
      }
      if (!item.currentRevisionId) {
        throw new DomainError('INTERNAL_ERROR', 'the item has no current revision', {
          objectIds: { knowledge_item: itemId },
        });
      }
      const passage = await this.o.read(workspaceId, itemId);
      if (!passage) {
        throw new DomainError(
          'INTERNAL_ERROR',
          'the repository does not contain the file this item names; restore it from a backup',
          { objectIds: { knowledge_item: itemId } },
        );
      }
      passages.push(passage);
      refs.push(dependencyRef(itemId, item.currentRevisionId));
    }

    const answer = await model.generate({
      instruction: SUMMARY_INSTRUCTION,
      input: passages.map(asInput).join('\n\n'),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    if (answer.text.trim() === '') {
      throw new DomainError('INTERNAL_ERROR', 'the model returned nothing');
    }
    return {
      body: answer.text.trim(),
      summaryOf: refs,
      model: model.profile.model,
      truncated: answer.truncated,
    };
  }
}

/**
 * One source as the model sees it.
 *
 * Titled and fenced, so a passage cannot run into the next one, and bounded: a
 * two-hundred-kilobyte document sent whole would fill the model's context with
 * one source and summarise nothing else.
 */
function asInput(passage: SourcePassage): string {
  const body = passage.body.trim();
  const bounded = body.length > MAX_SOURCE_CHARS ? `${body.slice(0, MAX_SOURCE_CHARS)}\n[…]` : body;
  return `### ${passage.title}\n\n${bounded}`;
}
