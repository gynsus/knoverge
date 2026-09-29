import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { readMarkdownFolder, type FolderCandidate } from '../src/importers/folder.ts';

/** The product's own rule, so a note that matches an item hashes the same. */
function normalise(value: string): string {
  return `${value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\n+$/u, '')}\n`;
}

const hashes = {
  contentHash: (title: string, body: string) =>
    `sha256:${createHash('sha256')
      .update(`${normalise(title)}\n${normalise(body)}`)
      .digest('hex')}`,
  sourceHash: (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`,
};

function read(files: { path: string; text: string }[]): FolderCandidate[] {
  return readMarkdownFolder({ files, ...hashes });
}

describe('a folder of Markdown, read as candidates', () => {
  it('takes the title a person meant, in the order they meant it', () => {
    const [declared, headed, named] = read([
      { path: 'a.md', text: '---\ntitle: What the frontmatter says\n---\n\n# And a heading\n' },
      { path: 'b.md', text: '# What the heading says\n\nSomething.\n' },
      { path: 'what-the-file-is-called.md', text: 'No title anywhere.\n' },
    ]);
    // Frontmatter beats a heading, a heading beats the filename: each is a
    // better statement of what the person meant than the next.
    expect(declared?.title).toBe('What the frontmatter says');
    expect(headed?.title).toBe('What the heading says');
    expect(named?.title).toBe('what the file is called');
  });

  it('hashes the text without the frontmatter, so a new tag is the same note', () => {
    const [before] = read([{ path: 'n.md', text: '# Escalation\n\nSupport first.\n' }]);
    const [after] = read([
      {
        path: 'n.md',
        text: '---\ntags: [ops]\ntitle: Escalation\n---\n\n# Escalation\n\nSupport first.\n',
      },
    ]);
    // The same rule GIT_REPOSITORY.md section 5 states for this product's own
    // files. It has to be the same, or nothing an importer brings would ever
    // match what the workspace holds.
    expect(after?.contentHash).toBe(before?.contentHash);
    // And the fingerprint of the file itself did change, which is the other
    // question an inventory answers: did my source change?
    expect(after?.sourceHash).not.toBe(before?.sourceHash);
  });

  it('takes an opening heading out of the text, because it is the title', () => {
    // This product's own files put the title in the frontmatter and not in the
    // body (GIT_REPOSITORY.md section 4). A note that opens with its own title
    // is stating it, not saying it twice — and leaving the heading in would
    // mean a note and the item made from it never hash the same, so an importer
    // could never tell a workspace that it already has something.
    const [fromHeading] = read([{ path: 'a.md', text: '# Escalation path\n\nSupport first.\n' }]);
    const [fromFrontmatter] = read([
      {
        path: 'b.md',
        text: '---\ntitle: Escalation path\n---\n\n# Escalation path\n\nSupport first.\n',
      },
    ]);
    const asThisProductWritesIt = hashes.contentHash('Escalation path', 'Support first.');
    expect(fromHeading?.contentHash).toBe(asThisProductWritesIt);
    expect(fromFrontmatter?.contentHash).toBe(asThisProductWritesIt);
  });

  it('leaves a heading that is not the title where it is', () => {
    const [candidate] = read([
      { path: 'c.md', text: '---\ntitle: Escalation\n---\n\n# Something else entirely\n\nText.\n' },
    ]);
    // Only an opening heading that repeats the title is punctuation. Anything
    // else is the note's own first line, and dropping it would lose text.
    expect(candidate?.contentHash).toBe(
      hashes.contentHash('Escalation', '# Something else entirely\n\nText.\n'),
    );
  });

  it('suggests the folder somebody filed it in, as a category path', () => {
    const [nested, top] = read([
      { path: 'Work Notes/Pixel Brisbane/auth.md', text: '# Auth\n\nHow it works.\n' },
      { path: 'loose.md', text: '# Loose\n\nNothing above it.\n' },
    ]);
    // A folder is the closest thing a person's notes have to a taxonomy, and it
    // is what they chose.
    expect(nested?.categoryPaths).toEqual(['work-notes/pixel-brisbane']);
    // And a file at the top is a candidate with no suggestion, rather than one
    // in a category called nothing.
    expect(top?.categoryPaths).toEqual([]);
  });

  it('collects the tags a person wrote, in either of the two places they write them', () => {
    const [list, oneLine, yamlList, inText] = read([
      { path: 'a.md', text: '---\ntags: [ops, on-call]\n---\n\nText.\n' },
      { path: 'b.md', text: '---\ntags: ops\n---\n\nText.\n' },
      { path: 'c.md', text: '---\ntags:\n  - ops\n  - on-call\n---\n\nText.\n' },
      { path: 'd.md', text: '# Note\n\nSee #ops and #on-call about this.\n' },
    ]);
    // All four are how people write tags, and an importer that understood one
    // of them would drop the others silently.
    expect(list?.tags).toEqual(['on-call', 'ops']);
    expect(oneLine?.tags).toEqual(['ops']);
    expect(yamlList?.tags).toEqual(['on-call', 'ops']);
    expect(inText?.tags).toEqual(['on-call', 'ops']);
  });

  it('does not mistake a heading or a fragment for a tag', () => {
    const [candidate] = read([
      {
        path: 'n.md',
        text: '---\ntitle: Note\n---\n\n# A heading\n\nWe use C# and https://x.test/a#b, tagged #real.\n',
      },
    ]);
    // A `#` at the start of a line is a heading; one inside a word is part of
    // the word. Neither is a tag, and a note that came back tagged `b` would be
    // worse than one with no tags at all.
    expect(candidate?.tags).toEqual(['real']);
  });

  it('counts a tag written both ways once', () => {
    const [candidate] = read([{ path: 'n.md', text: '---\ntags: [Ops]\n---\n\nSee #ops.\n' }]);
    expect(candidate?.tags).toEqual(['ops']);
  });

  it('reads what a note links to, however the link is dressed up', () => {
    const [candidate] = read([
      {
        path: 'n.md',
        text: '# Auth\n\nSee [[Escalation path]], [[Rota|the rota]] and [[Runbook#On call]].\n',
      },
    ]);
    // The display text and the heading are about how a link reads, not about
    // what it points at.
    expect(candidate?.links).toEqual(['Escalation path', 'Rota', 'Runbook']);
  });

  it('does not read a link out of a code block, or a tag either', () => {
    const [candidate] = read([
      {
        path: 'n.md',
        text: '# Syntax\n\nWrite `[[Target]]` for a link and `#tag` for a tag.\n\n```\n[[Another]]\n#alsonot\n```\n',
      },
    ]);
    // A note about wiki syntax is not a note that links to anything, and one
    // about tagging is not tagged.
    expect(candidate?.links).toEqual([]);
    expect(candidate?.tags).toEqual([]);
  });

  it('carries the first paragraph, so a reviewer reads something', () => {
    const [candidate] = read([
      { path: 'n.md', text: '# Heading\n\nThe first thing it says.\n\nThe second.\n' },
    ]);
    expect(candidate?.abstract).toBe('The first thing it says.');
  });

  it('keeps a note whose frontmatter is broken, because it is still a note', () => {
    const candidates = read([
      { path: 'broken.md', text: '---\ntitle: [unclosed\n---\n\n# Still a note\n\nText.\n' },
    ]);
    // A YAML parser here would refuse it. What is wanted is a title if one is
    // there, and this one has a heading either way.
    expect(candidates).toHaveLength(1);
  });

  it('reads only Markdown, and says nothing about the rest', () => {
    const candidates = read([
      { path: 'note.md', text: '# A note\n\nText.\n' },
      { path: 'note.markdown', text: '# Another\n\nText.\n' },
      { path: 'photo.png', text: 'not text at all' },
      { path: 'sheet.csv', text: 'a,b,c' },
    ]);
    expect(candidates.map((candidate) => candidate.path)).toEqual(['note.md', 'note.markdown']);
  });

  it('keeps the path, which is what stays the same between runs', () => {
    const [candidate] = read([{ path: 'projects/auth.md', text: '# Auth\n\nText.\n' }]);
    // A title changes and a body changes; the path is what the person filing it
    // chose, so it is the key a second run is matched by (ADR 0036).
    expect(candidate?.path).toBe('projects/auth.md');
  });
});
