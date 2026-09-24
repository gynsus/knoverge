import type {
  FrontmatterRelation,
  FrontmatterSource,
  ItemType,
  KnowledgeItemDetail,
} from '@knoverge/contracts';

/** The fields a person edits. Everything else follows from them. */
export interface Draft {
  title: string;
  body: string;
  type: ItemType;
  categories: string;
  tags: string;
  /** Where this came from, and how it connects to the rest. */
  sources: FrontmatterSource[];
  relations: FrontmatterRelation[];
}

export const emptyDraft: Draft = {
  title: '',
  body: '',
  type: 'fact',
  categories: '',
  tags: '',
  sources: [],
  relations: [],
};

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
  sources: [...item.sources],
  relations: [...item.relations],
});

/** Whether anything in the form differs from the item it started at. */
export const changed = (draft: Draft, from: Draft): boolean =>
  draft.title !== from.title ||
  draft.body !== from.body ||
  draft.type !== from.type ||
  draft.categories !== from.categories ||
  draft.tags !== from.tags ||
  // Compared as JSON: these are small, ordered lists of plain values, and a
  // field-by-field comparison here would be a second definition of what a
  // source is, drifting from the first one.
  JSON.stringify(draft.sources) !== JSON.stringify(from.sources) ||
  JSON.stringify(draft.relations) !== JSON.stringify(from.relations);
