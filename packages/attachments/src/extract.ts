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

/** What the Word reader is, without naming the module in a type position. */
type ReadWord = (input: { buffer: Buffer }) => Promise<{ value: string }>;

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
 * The words on the pages of a PDF.
 *
 * `unpdf` rather than `pdfjs-dist` itself: it is the same engine in a build meant
 * to run outside a browser, at two megabytes instead of thirty-five, and it needs
 * no worker, no canvas and no fonts fetched from anywhere — this reads text and
 * never renders a page (rule 12).
 *
 * Imported where it is used rather than at the top of the file, so an
 * installation that never uploads a PDF does not load a PDF engine, and
 * `knoverge integrity check` does not load one at all.
 */
async function fromPdf(bytes: Uint8Array): Promise<Extraction> {
  const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
  // A plain `Uint8Array` and never a `Buffer`, which is what a file read from
  // disk is: the engine refuses one outright, because a Buffer is a view into a
  // pool it would then hold a reference into.
  const document = await getDocumentProxy(bytes instanceof Buffer ? new Uint8Array(bytes) : bytes);
  const { text } = await pdfText(document, { mergePages: true });
  const trimmed = text.trim();
  if (trimmed === '') {
    // A scan is a picture of a page. There is nothing here to read, and reading
    // it is Milestone 12's job — so this is an answer rather than a failure, and
    // the file is kept for whoever can read it.
    return {
      kind: 'unsupported',
      reason: 'this PDF has no text layer; it is a scan, and reading one needs OCR',
    };
  }
  return { kind: 'text', text: trimmed };
}

/**
 * The text of a Word document.
 *
 * `mammoth`, which is a small focused library that has been doing this for years,
 * rather than a zip reader and an XML parser here: a `.docx` is only simple until
 * it has a table, a footnote or a list in it.
 */
async function fromDocx(bytes: Uint8Array): Promise<Extraction> {
  // The namespace under ESM, the module itself under CommonJS: the package ships
  // one shape and Node hands over the other depending on how it is loaded.
  const loaded = (await import('mammoth')) as unknown as {
    extractRawText?: ReadWord;
    default?: { extractRawText: ReadWord };
  };
  const extractRawText = loaded.extractRawText ?? loaded.default?.extractRawText;
  if (!extractRawText) throw new Error('the document reader did not load');
  const { value } = await extractRawText({ buffer: Buffer.from(bytes) });
  // Word ends every paragraph with its own blank line, and an empty cell is a
  // paragraph too: what arrives has runs of them, and what a person reads does not.
  const text = value.replace(/\n{3,}/gu, '\n\n').trim();
  return text === ''
    ? { kind: 'failed', reason: 'the document holds no text' }
    : { kind: 'text', text };
}

/**
 * The text inside a file, or why there is none.
 *
 * `maxCharacters` is the size one knowledge item may hold. A file whose text is
 * larger is a failure rather than a truncation: half a document stored as if it
 * were the whole one is the kind of thing nobody notices until they rely on it.
 */
export async function extractText(
  mediaType: string,
  bytes: Uint8Array,
  maxCharacters: number,
): Promise<Extraction> {
  const type = baseType(mediaType);
  const found = await read(type, bytes);
  if (found.kind !== 'text') return found;

  const text = found.text.trim();
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

/** Which reader the type calls for, and what it says when there is none. */
async function read(type: string, bytes: Uint8Array): Promise<Extraction> {
  if (type === PDF) {
    try {
      return await fromPdf(bytes);
    } catch (err) {
      return { kind: 'failed', reason: reasonOf(err, 'this PDF could not be read') };
    }
  }
  if (type === DOCX) {
    try {
      return await fromDocx(bytes);
    } catch (err) {
      return { kind: 'failed', reason: reasonOf(err, 'this document could not be read') };
    }
  }
  if (PLAIN.has(type) || HTML.has(type) || type.startsWith('text/')) {
    const decoded = decode(bytes);
    if (decoded === null) {
      return { kind: 'failed', reason: `the file is not ${type} text` };
    }
    return { kind: 'text', text: HTML.has(type) ? fromHtml(decoded) : decoded };
  }
  return { kind: 'unsupported', reason: `nothing here reads ${type || 'that type'}` };
}

/**
 * What went wrong, in one line and without a stack.
 *
 * A parser's message is about a file somebody uploaded, so it goes on the row an
 * operator reads. It is truncated because some of them quote the file.
 */
function reasonOf(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  return message ? `${fallback}: ${message.slice(0, 200)}` : fallback;
}
