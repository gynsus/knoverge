import { FRONTMATTER_KEY_ORDER, Frontmatter } from '@knoverge/contracts';
import { parse, stringify } from 'yaml';

import { normalise } from './content.ts';

/** An item as the repository holds it: frontmatter, then the knowledge itself. */
export interface MarkdownItem {
  frontmatter: Frontmatter;
  /** The Markdown body. A title heading is not required; the frontmatter has it. */
  body: string;
}

export class MarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownError';
  }
}

/** Opens and closes the frontmatter block, on lines of their own. */
const FENCE = '---';

/**
 * Renders an item to the file the repository stores.
 *
 * Keys are written in the order `docs/GIT_REPOSITORY.md` section 3 fixes, and a
 * field that is absent is left out rather than written as null — except the
 * three validity instants, which are written as `null` because the document
 * shows them that way and their absence means something different from their
 * being unset.
 *
 * Two renderings of the same item are the same bytes. That is the whole point:
 * a diff then shows what changed rather than how the serialiser felt about it.
 */
export function renderItem(item: MarkdownItem): string {
  const parsed = Frontmatter.safeParse(item.frontmatter);
  if (!parsed.success) {
    throw new MarkdownError(`frontmatter is not valid: ${issues(parsed.error)}`);
  }
  const value = parsed.data as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEY_ORDER) {
    const field = value[key];
    if (field === undefined) continue;
    // Empty lists carry no information a reader needs, and a page of them is
    // not a file anybody wants to read. `null` is kept: it is a stated value.
    if (Array.isArray(field) && field.length === 0) continue;
    ordered[key] = field;
  }
  const yaml = stringify(ordered, { lineWidth: 0 }).trimEnd();
  return `${FENCE}\n${yaml}\n${FENCE}\n\n${normalise(item.body)}`;
}

/**
 * Reads a file back.
 *
 * An unknown key is an error rather than something to drop. Dropping one would
 * discard whatever a later version of Knoverge, or another implementation,
 * meant by it — and this file is the canonical copy, not a cache of one.
 */
export function parseItem(text: string): MarkdownItem {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalised.startsWith(`${FENCE}\n`)) {
    throw new MarkdownError('the file does not start with a frontmatter block');
  }
  const end = normalised.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    throw new MarkdownError('the frontmatter block is never closed');
  }
  const yaml = normalised.slice(FENCE.length + 1, end + 1);
  const after = normalised.slice(end + 1 + FENCE.length);
  if (after !== '' && !after.startsWith('\n')) {
    throw new MarkdownError('the closing fence must be on a line of its own');
  }

  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (error) {
    throw new MarkdownError(`the frontmatter is not valid YAML: ${message(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MarkdownError('the frontmatter is not a mapping');
  }
  const parsed = Frontmatter.safeParse(raw);
  if (!parsed.success) {
    throw new MarkdownError(`frontmatter is not valid: ${issues(parsed.error)}`);
  }
  // The blank line after the closing fence separates the block from the body;
  // it is punctuation, not the first line of the knowledge.
  return { frontmatter: parsed.data, body: normalise(after.replace(/^\n+/, '')) };
}

/** The title and body as the content hash sees them, ignoring the metadata. */
export function itemContent(item: MarkdownItem): { title: string; body: string } {
  return { title: item.frontmatter.title, body: item.body };
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
