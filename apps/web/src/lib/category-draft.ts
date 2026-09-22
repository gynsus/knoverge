import type { CategorySummary } from '@knoverge/contracts';

/** Everything about a category that somebody edits, as text they typed. */
export interface CategoryDraft {
  name: string;
  slug: string;
  parentId: string | null;
  description: string;
  inclusion: string;
  exclusion: string;
  aliases: string;
}

export const emptyDraft: CategoryDraft = {
  name: '',
  slug: '',
  parentId: null,
  description: '',
  inclusion: '',
  exclusion: '',
  aliases: '',
};

export function draftOf(category: CategorySummary): CategoryDraft {
  return {
    name: category.name,
    slug: category.slug,
    parentId: category.parent_id,
    description: category.description ?? '',
    inclusion: category.inclusion_guidance.join('\n'),
    exclusion: category.exclusion_guidance.join('\n'),
    aliases: category.aliases.join(', '),
  };
}

/** One guidance line per line, blanks dropped. */
export function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function splitCommas(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
