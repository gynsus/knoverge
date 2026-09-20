import { createHash } from 'node:crypto';

/**
 * Normalisation applied before hashing, from docs/GIT_REPOSITORY.md section 5.
 *
 * The point is that the same knowledge hashes the same however it was typed:
 * on Windows or on Linux, with trailing spaces or without, with one blank line
 * between paragraphs or four.
 */
export function normalise(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n+$/, '') + '\n'
  );
}

/**
 * Identifies the knowledge itself, independent of its metadata.
 *
 * Frontmatter is excluded on purpose: recategorising, retagging or reviewing an
 * item does not change what it says, and this is the hash an agent compares
 * during reconciliation.
 *
 * Normalisation already ends each part with exactly one newline, so the single
 * newline joining them is the blank line between title and body. An agent
 * computing this from docs/GIT_REPOSITORY.md section 5 has to produce the same
 * bytes, and a digest one newline apart is a digest that never matches.
 */
export function contentHash(title: string, body: string): string {
  const canonical = `${normalise(title)}\n${normalise(body)}`;
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Identifies the metadata, so a metadata-only revision is distinguishable. */
export function frontmatterHash(yaml: string): string {
  return `sha256:${createHash('sha256').update(normalise(yaml), 'utf8').digest('hex')}`;
}
