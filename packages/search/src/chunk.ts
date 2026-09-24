/**
 * How long a chunk aims to be, in characters.
 *
 * Characters rather than tokens: a token count needs a tokeniser that agrees
 * with an embedding model, and the index has to be buildable when no model is
 * configured at all (ADR 0020).
 */
export const TARGET_CHUNK_CHARS = 600;

/** The ceiling. A paragraph longer than this is split rather than kept whole. */
export const MAX_CHUNK_CHARS = 1_200;

/** One piece of an item's body, in the order it appears. */
export interface Chunk {
  /** Zero-based, and stable for the same text. */
  ordinal: number;
  text: string;
}

/**
 * Sentence ends, for splitting a paragraph that is too long to keep whole.
 *
 * Deliberately crude: a full stop, question mark or exclamation mark followed
 * by whitespace. It mis-handles abbreviations, and that costs a chunk boundary
 * in a slightly wrong place, which costs nothing anybody can observe. The
 * alternative is a sentence tokeniser per language, which is a dependency and
 * a source of disagreement between versions.
 */
const SENTENCE_END = /(?<=[.!?…])\s+/u;

/**
 * Splits a body into chunks, deterministically.
 *
 * Paragraphs are what the author already divided the text into, so they are
 * the unit: blank-line separated, then merged while they fit, so a two-line
 * paragraph does not become a chunk of its own. A paragraph over the ceiling
 * is split on sentence ends, and a sentence over the ceiling — a table row, a
 * minified blob, a language this does not understand — on the ceiling itself,
 * because something has to give and losing the text is not an option.
 *
 * The same text produces the same chunks on any machine and any version. That
 * is what lets `knoverge db reindex` rebuild the index from the canonical
 * files and get the same index back; an index nobody can reproduce is a second
 * source of truth.
 */
export function chunkBody(body: string): Chunk[] {
  const pieces: string[] = [];
  let buffer = '';

  const flush = () => {
    const text = buffer.trim();
    if (text !== '') pieces.push(text);
    buffer = '';
  };

  for (const paragraph of paragraphsOf(body)) {
    for (const part of withinCeiling(paragraph)) {
      // Keep filling while the result still fits the target. An empty buffer
      // always takes the part, or a long one would never be placed.
      const joined = buffer === '' ? part : `${buffer}\n\n${part}`;
      if (buffer !== '' && joined.length > TARGET_CHUNK_CHARS) {
        flush();
        buffer = part;
      } else {
        buffer = joined;
      }
    }
  }
  flush();

  return pieces.map((text, ordinal) => ({ ordinal, text }));
}

/** Blank-line separated, with trailing whitespace gone. */
function paragraphsOf(body: string): string[] {
  return body
    .replace(/\r\n/gu, '\n')
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

/** One paragraph, cut down to pieces no longer than the ceiling. */
function withinCeiling(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_CHARS) return [paragraph];
  const out: string[] = [];
  let current = '';
  for (const sentence of paragraph.split(SENTENCE_END)) {
    const joined = current === '' ? sentence : `${current} ${sentence}`;
    if (current !== '' && joined.length > MAX_CHUNK_CHARS) {
      out.push(current);
      current = sentence;
    } else {
      current = joined;
    }
  }
  if (current !== '') out.push(current);
  // A single sentence longer than the ceiling still has to be placed.
  return out.flatMap((piece) =>
    piece.length <= MAX_CHUNK_CHARS ? [piece] : hardSplit(piece, MAX_CHUNK_CHARS),
  );
}

/**
 * The last resort: cut on the ceiling, at a space where one is near.
 *
 * Code points rather than UTF-16 units, so a cut never lands inside a
 * character that is written as a surrogate pair.
 */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = [...text];
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const lastSpace = window.lastIndexOf(' ');
    const cut = lastSpace > limit / 2 ? lastSpace : limit;
    out.push(window.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
  }
  const tail = rest.join('').trim();
  if (tail !== '') out.push(tail);
  return out;
}
