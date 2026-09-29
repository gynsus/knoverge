/**
 * What one record in a JSON file has to say about itself.
 *
 * The smallest shape that can become a candidate: something to call it, and
 * something that identifies it in the system it came from. Everything else is
 * optional, because the point of this importer is the exports nobody wrote a
 * parser for — a Notion export, a wiki dump, somebody's script — and each of
 * them has a different idea of what a note carries.
 */
export interface JsonRecord {
  /** What identifies it where it came from. The key a second run matches by. */
  id?: unknown;
  title?: unknown;
  body?: unknown;
  text?: unknown;
  content?: unknown;
  tags?: unknown;
  categories?: unknown;
  category?: unknown;
  [key: string]: unknown;
}

export interface JsonCandidate {
  /** The record's own id, or its position when it has none. */
  key: string;
  title: string;
  body: string;
  tags: string[];
  categoryPaths: string[];
  contentHash: string;
  sourceHash: string;
  abstract: string;
}

export interface ReadJsonOptions {
  /** The parsed file: an array, or an object with an array under one key. */
  parsed: unknown;
  contentHash: (title: string, body: string) => string;
  sourceHash: (text: string) => string;
}

/**
 * Records from a JSON export, read as candidates.
 *
 * Deliberately forgiving about shape and strict about meaning. A record needs a
 * title and a body to be knowledge, and everything else is a best reading of
 * what the exporter chose to call things: `body`, `text` and `content` are the
 * three names the same field goes by, and a record that has none of them is not
 * knowledge in any of them.
 *
 * What it will not do is guess an identity. A record with no id is keyed by its
 * position, which is stable only while the file is — so the report says how many
 * of those there were, and somebody who runs this twice on a changing export
 * finds out from the count rather than from a workspace full of duplicates.
 */
export function readJsonRecords(options: ReadJsonOptions): {
  candidates: JsonCandidate[];
  /** Records that had no title or no body, which are not knowledge. */
  skipped: number;
  /** Candidates keyed by position because the record carried no id. */
  positional: number;
} {
  const records = recordsIn(options.parsed);
  const candidates: JsonCandidate[] = [];
  let skipped = 0;
  let positional = 0;

  records.forEach((record, index) => {
    const title = text(record['title'] ?? record['name'] ?? record['heading']).slice(0, 300);
    const body = text(record['body'] ?? record['text'] ?? record['content'] ?? record['markdown']);
    if (title === '' || body.trim() === '') {
      skipped += 1;
      return;
    }
    const id = text(record['id'] ?? record['key'] ?? record['uuid'] ?? record['slug']);
    if (id === '') positional += 1;
    candidates.push({
      key: id === '' ? `#${index}` : id.slice(0, 512),
      title,
      body,
      tags: list(record['tags'])
        .map((tag) => tag.toLowerCase())
        .filter(Boolean)
        .sort(),
      categoryPaths: list(record['categories'] ?? record['category'])
        .map((path) =>
          path
            .toLowerCase()
            .replace(/[^a-z0-9/]+/gu, '-')
            .replace(/^-+|-+$/gu, ''),
        )
        .filter((path) => path !== ''),
      contentHash: options.contentHash(title, body),
      // The record as it was, so a second run can tell whether the source moved
      // even when the title and the text did not.
      sourceHash: options.sourceHash(JSON.stringify(record)),
      abstract: body.replace(/\s+/gu, ' ').trim().slice(0, 1000),
    });
  });

  return { candidates, skipped, positional };
}

/**
 * The records in whatever the file turned out to be.
 *
 * An array is the obvious shape. An object with one array in it is the other
 * one exporters use — `{ "pages": [...] }` — and picking the only array is a
 * better guess than refusing the file. An object with several is ambiguous and
 * is refused, because choosing one of them would be choosing what to import.
 */
function recordsIn(parsed: unknown): JsonRecord[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  const arrays = Object.values(parsed).filter((value): value is unknown[] => Array.isArray(value));
  return arrays.length === 1 ? (arrays[0] as unknown[]).filter(isRecord) : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field as text, whatever the exporter made it. */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** A field as a list, whether it is one, a string, or a comma-separated line. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((entry) => entry !== '');
  const single = text(value);
  if (single === '') return [];
  return single
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
