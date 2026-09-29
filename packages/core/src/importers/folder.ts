/**
 * What one file in a folder turns into.
 *
 * Deliberately not a knowledge item: an inventory says what a candidate *is*
 * and what it fingerprints to, never what it says. The bodies of the ones that
 * turn out to be new are sent when they are proposed (ADR 0036).
 */
export interface FolderCandidate {
  /** The path inside the folder, which is what stays the same between runs. */
  path: string;
  title: string;
  /** The categories the folder structure suggests, deepest first entry. */
  categoryPaths: string[];
  /**
   * The text, once the frontmatter and a title heading are out of it.
   *
   * Not part of an inventory — that carries fingerprints and never the text
   * (ADR 0036). It is here because whatever proposes a candidate later has to
   * send the same body the fingerprint was taken of, and reading the file a
   * second time with a second idea of where the body starts is how the two
   * would disagree.
   */
  body: string;
  /** Of the normalised title and body: does the workspace hold this text? */
  contentHash: string;
  /** Of the file as it was read: did my source change? */
  sourceHash: string;
  /** The first paragraph, so a reviewer reads something before opening it. */
  abstract: string;
  /**
   * The tags the note carries, from its frontmatter and from its text.
   *
   * Not part of an inventory either: what a note is tagged does not help decide
   * whether the workspace already holds it. Carried for the same reason the body
   * is — whatever proposes the candidate has them without reading the file
   * again.
   */
  tags: string[];
  /**
   * What the note links to, as written: `[[Another note]]`.
   *
   * Targets and not relations: the note on the other end may not be an item yet,
   * and a relation needs both ends. Resolving them is a second pass after a run,
   * which is where these are turned into something the workspace can hold.
   */
  links: string[];
}

export interface ReadFolderOptions {
  /** Relative path, file contents. Whatever walked the directory produces it. */
  files: readonly { path: string; text: string }[];
  contentHash: (title: string, body: string) => string;
  sourceHash: (text: string) => string;
}

/**
 * A folder of Markdown, read as candidates for a reconciliation session.
 *
 * The title is taken from the frontmatter when there is one, then from the first
 * heading, and only then from the filename — in that order because each is a
 * better statement of what the person meant than the next. A file that says
 * nothing about itself is still a candidate under its own name.
 *
 * The body used for the content hash is the file without its frontmatter, so a
 * note that gained a tag is the same text it was and matches what the workspace
 * already holds. That is the same rule `GIT_REPOSITORY.md` section 5 states for
 * this product's own files, and it has to be the same or nothing would ever
 * match.
 */
export function readMarkdownFolder(options: ReadFolderOptions): FolderCandidate[] {
  const candidates: FolderCandidate[] = [];
  for (const file of options.files) {
    if (!file.path.endsWith('.md') && !file.path.endsWith('.markdown')) continue;
    const { frontmatter, body } = split(file.text);
    const titled = titleOf(frontmatter, body, file.path);
    if (titled.title === '') continue;
    const { title, text } = titled;
    candidates.push({
      path: file.path,
      title,
      categoryPaths: categoriesOf(file.path),
      body: text,
      contentHash: options.contentHash(title, text),
      sourceHash: options.sourceHash(file.text),
      abstract: abstractOf(text),
      tags: tagsOf(frontmatter, text),
      links: linksOf(text),
    });
  }
  return candidates;
}

/**
 * Frontmatter and body, when the file has frontmatter.
 *
 * Read as lines rather than parsed as YAML: what is wanted is a title if one is
 * there, and a file whose frontmatter is not valid YAML is still a note somebody
 * wrote. A parser here would refuse it.
 */
function split(text: string): { frontmatter: string; body: string } {
  const normalised = text.replace(/\r\n?/gu, '\n');
  if (!normalised.startsWith('---\n')) return { frontmatter: '', body: normalised };
  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: normalised };
  const after = normalised.indexOf('\n', end + 1);
  return {
    frontmatter: normalised.slice(4, end),
    // The blank line people leave under the frontmatter is punctuation, not
    // text. Keeping it would make the same note hash differently depending on
    // whether it has frontmatter at all, and then nothing an importer brings
    // would ever match what the workspace holds.
    body: after === -1 ? '' : normalised.slice(after + 1).replace(/^\n+/u, ''),
  };
}

/** `title: something`, in the frontmatter, quoted or not. */
const TITLE_LINE = /^title:\s*(.+?)\s*$/mu;
/** The first ATX heading of any level. */
const HEADING = /^#{1,6}\s+(.+?)\s*$/mu;

/**
 * The title, and the text left once it has been taken out.
 *
 * A note that opens with `# Its own title` is stating its title, not saying it
 * twice — and this product's own files put the title in the frontmatter and not
 * in the body (`GIT_REPOSITORY.md` section 4). Leaving the heading in the text
 * would mean a note and the item made from it never hash the same, and then an
 * importer could never tell a workspace that it already has something.
 */
function titleOf(frontmatter: string, body: string, path: string): { title: string; text: string } {
  const declared = TITLE_LINE.exec(frontmatter)?.[1];
  if (declared)
    return { title: unquote(declared).slice(0, 300), text: withoutTitle(body, unquote(declared)) };
  const heading = HEADING.exec(body);
  if (heading?.[1] && heading.index === 0) {
    return {
      title: heading[1].slice(0, 300),
      text: body.slice(heading[0].length).replace(/^\n+/u, ''),
    };
  }
  if (heading?.[1]) return { title: heading[1].slice(0, 300), text: body };
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/u, '');
  return { title: name.replace(/[-_]+/gu, ' ').trim().slice(0, 300), text: body };
}

/** Drops an opening heading that repeats the title the frontmatter declared. */
function withoutTitle(body: string, title: string): string {
  const heading = HEADING.exec(body);
  if (heading?.index !== 0 || heading[1]?.trim() !== title.trim()) return body;
  return body.slice(heading[0].length).replace(/^\n+/u, '');
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/u.exec(value);
  return quoted ? (quoted[2] as string) : value;
}

/**
 * The directories above the file, as a category path.
 *
 * A folder is the closest thing a person's notes have to a taxonomy, and it is
 * what they chose. Empty for a file at the top, which is a candidate with no
 * suggestion rather than one in a category called nothing.
 */
function categoriesOf(path: string): string[] {
  const cut = path.lastIndexOf('/');
  if (cut === -1) return [];
  const directory = path
    .slice(0, cut)
    .split('/')
    .map((segment) => slugSegment(segment))
    .filter((segment) => segment !== '')
    .join('/');
  return directory === '' ? [] : [directory];
}

/** A directory name as a category path segment: lowercase, hyphenated. */
function slugSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * What a note links to.
 *
 * `[[Target]]`, `[[Target|shown as this]]` and `[[Target#a heading]]` are all one
 * link to `Target`: the display text and the heading are about how the link
 * reads, not about what it points at. A link inside a code fence is left alone,
 * because a note about wiki syntax is not a note that links to anything.
 */
function linksOf(body: string): string[] {
  const found = new Set<string>();
  for (const match of withoutCode(body).matchAll(
    /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gu,
  )) {
    const target = (match[1] ?? '').trim();
    if (target !== '' && target.length <= 512) found.add(target);
  }
  return [...found].sort();
}

/** The text with fenced and inline code taken out, so syntax is not content. */
function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/gu, '').replace(/`[^`\n]*`/gu, '');
}

/**
 * The tags a note carries.
 *
 * Two places, because a person writing notes uses both: `tags:` in the
 * frontmatter, as a list or as one line, and `#tag` in the text, which is what
 * Obsidian and most editors do. A tag written both ways is one tag.
 *
 * `#` at the start of a line is a heading and not a tag, and a `#` inside a word
 * — `C#`, a URL fragment — is not one either.
 */
function tagsOf(frontmatter: string, body: string): string[] {
  const found = new Set<string>();
  // `[^\S\n]` and not `\s`: `\s` matches a newline, so `tags:` followed by a
  // list on the lines below would swallow the first item as if it were written
  // on the same line.
  const declared = /^tags:[^\S\n]*(.*)$/mu.exec(frontmatter);
  if (declared) {
    const inline = declared[1]?.trim() ?? '';
    if (inline.startsWith('[')) {
      for (const value of inline.slice(1, inline.lastIndexOf(']')).split(',')) {
        add(found, value);
      }
    } else if (inline !== '') {
      add(found, inline);
    } else {
      // A YAML list on the lines below, which is the other way people write it.
      // Past the end of the `tags:` line itself, which is where the list is.
      const below = frontmatter.slice(declared.index + declared[0].length).replace(/^\n/u, '');
      for (const line of below.split('\n')) {
        const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
        if (!item) break;
        add(found, item[1] ?? '');
      }
    }
  }
  for (const match of withoutCode(body).matchAll(/(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}/_-]*)/gmu)) {
    add(found, match[2] ?? '');
  }
  return [...found].sort();
}

/** One tag, normalised the way a tag is written here: lowercase, trimmed. */
function add(into: Set<string>, value: string): void {
  const tag = value
    .trim()
    .replace(/^['"]|['"]$/gu, '')
    .replace(/^#/u, '')
    .toLowerCase();
  if (tag !== '' && tag.length <= 64) into.add(tag);
}

/** The first paragraph that is not a heading, trimmed to something readable. */
function abstractOf(body: string): string {
  for (const paragraph of body.split(/\n\s*\n/u)) {
    const text = paragraph.trim();
    if (text === '' || text.startsWith('#')) continue;
    return text.replace(/\s+/gu, ' ').slice(0, 1000);
  }
  return '';
}
