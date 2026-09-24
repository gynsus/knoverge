import type { ItemType, KnowledgeItemDetail } from '@knoverge/contracts';

/** The fields a person edits. Everything else follows from them. */
export interface Draft {
  title: string;
  body: string;
  type: ItemType;
  categories: string;
  tags: string;
}

export const emptyDraft: Draft = { title: '', body: '', type: 'fact', categories: '', tags: '' };

/**
 * A comma-separated field as a list.
 *
 * Comma rather than space, because a tag may contain a space (ADR 0019) and a
 * category path may not contain either.
 */
export const listOf = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export const draftOf = (item: KnowledgeItemDetail): Draft => ({
  title: item.title,
  body: item.body,
  type: item.type,
  categories: item.categories.join(', '),
  tags: item.tags.join(', '),
});

/** Whether anything in the form differs from the item it started at. */
export const changed = (draft: Draft, from: Draft): boolean =>
  draft.title !== from.title ||
  draft.body !== from.body ||
  draft.type !== from.type ||
  draft.categories !== from.categories ||
  draft.tags !== from.tags;
