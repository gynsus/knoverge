import { MAX_SLUG_LENGTH } from '@knoverge/contracts';

/** Latin transliteration for the scripts a slug cannot carry directly. */
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Re-exported from the contract rather than chosen here.
 *
 * This constant said eighty while the schema and the database column said
 * sixty-four, so a long title produced a slug this function was happy with
 * and nothing downstream would take.
 */
export { MAX_SLUG_LENGTH };

/**
 * A file name derived from a title: lowercase, transliterated, hyphenated.
 *
 * It is assigned once and does not change when the title changes, so a casual
 * edit does not move the file (GIT_REPOSITORY.md section 2).
 */
export function slugifyTitle(title: string): string {
  const transliterated = [...title.toLowerCase()]
    .map((char) => CYRILLIC[char] ?? char)
    .join('')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/** The next free name in a directory, appending -2, -3 and so on. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
