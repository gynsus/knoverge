/**
 * Getting the text out of a file, without asking anything.
 *
 * Extraction runs with no AI provider configured and no network (ADR 0008 point
 * 4, rule 9). What comes out is meant to be read and searched, not to be a
 * faithful rendering: a document item is the text of a file, and the file itself
 * stays where it is for anybody who wants the original.
 */

/** What a file turned out to hold. */
export type Extraction =
  | { kind: 'text'; text: string }
  /** Nothing here can read this type. The file is kept and referred to. */
  | { kind: 'unsupported'; reason: string }
  /** The type is one this understands and the contents are not what they claim. */
  | { kind: 'failed'; reason: string };

/** The types this reads today. PDF and DOCX are the next part of the milestone. */
const PLAIN = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/yaml',
  'text/yaml',
]);

const HTML = new Set(['text/html', 'application/xhtml+xml']);

/** Where a media type stops and its parameters begin: `text/plain; charset=utf-8`. */
function baseType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Bytes as text, when they are text at all.
 *
 * A file labelled `text/plain` may be anything. Decoding gives replacement
 * characters for what is not UTF-8, so a count of those is the honest test: a
 * little is a file with a stray byte, a lot is somebody's photograph with the
 * wrong type on it.
 */
function decode(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('\u0000')) return null;
  let replacements = 0;
  for (const character of text) if (character === '\ufffd') replacements += 1;
  return replacements > Math.max(4, text.length * 0.02) ? null : text;
}

/** Entities a document written by a person actually contains. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body.startsWith('#x') || body.startsWith('#X')
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * A page as the text somebody reads off it.
 *
 * Deliberately modest, and the limits are the point: `script` and `style` go
 * with their contents, block elements become line breaks, tags are removed and
 * entities decoded. It is not a renderer and does not try to be — an installation
 * that needs a faithful conversion has the original file to convert.
 */
function fromHtml(html: string): string {
  const withoutScripts = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/giu, '');
  const spaced = withoutScripts
    .replace(
      /<\/?(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/giu,
      '\n',
    )
    .replace(/<br\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, '');
  return decodeEntities(spaced)
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\n\s*\n\s*\n+/gu, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * The text inside a file, or why there is none.
 *
 * `maxCharacters` is the size one knowledge item may hold. A file whose text is
 * larger is a failure rather than a truncation: half a document stored as if it
 * were the whole one is the kind of thing nobody notices until they rely on it.
 */
export function extractText(
  mediaType: string,
  bytes: Uint8Array,
  maxCharacters: number,
): Extraction {
  const type = baseType(mediaType);
  const readable = PLAIN.has(type) || HTML.has(type) || type.startsWith('text/');
  if (!readable) {
    return { kind: 'unsupported', reason: `nothing here reads ${type || 'that type'}` };
  }

  const decoded = decode(bytes);
  if (decoded === null) {
    return { kind: 'failed', reason: `the file is not ${type} text` };
  }

  const text = (HTML.has(type) ? fromHtml(decoded) : decoded).trim();
  if (text === '') {
    return { kind: 'failed', reason: 'the file holds no text' };
  }
  if (text.length > maxCharacters) {
    return {
      kind: 'failed',
      reason: `the text is ${text.length} characters and one item holds ${maxCharacters}`,
    };
  }
  return { kind: 'text', text };
}
