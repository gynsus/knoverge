/**
 * A slug suggestion from a name somebody typed.
 *
 * Only a suggestion: the field stays editable, and the server validates what
 * is actually sent. Decomposing first means an accented letter loses its mark
 * rather than the whole letter, so "Café" suggests "cafe" and not "caf".
 * Scripts with no Latin form — Cyrillic, Chinese — leave nothing behind, which
 * is why an empty result has to be an ordinary case for the caller.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
