import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { readJsonRecords } from '../src/importers/json.ts';

const hashes = {
  contentHash: (title: string, body: string) =>
    `sha256:${createHash('sha256').update(`${title}\n${body}`).digest('hex')}`,
  sourceHash: (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`,
};

function read(parsed: unknown) {
  return readJsonRecords({ parsed, ...hashes });
}

describe('records from a JSON export', () => {
  it('reads the three names the same field goes by', () => {
    const { candidates } = read([
      { id: 'a', title: 'One', body: 'Said as body.' },
      { id: 'b', title: 'Two', text: 'Said as text.' },
      { id: 'c', title: 'Three', content: 'Said as content.' },
    ]);
    // The point of this importer is the exports nobody wrote a parser for, and
    // each has a different idea of what the field is called.
    expect(candidates.map((candidate) => candidate.body)).toEqual([
      'Said as body.',
      'Said as text.',
      'Said as content.',
    ]);
  });

  it('leaves out a record that is not knowledge, and says how many', () => {
    const { candidates, skipped } = read([
      { id: 'a', title: 'Has both', body: 'Text.' },
      { id: 'b', title: 'No body' },
      { id: 'c', body: 'No title' },
      { id: 'd', title: 'Empty body', body: '   ' },
    ]);
    // A record needs a title and a body to be knowledge. Counting the rest is
    // what tells somebody their export had a shape this did not understand.
    expect(candidates).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it('keys by the record’s own id, and counts the ones that have none', () => {
    const { candidates, positional } = read([
      { id: 'page-1', title: 'A', body: 'Text.' },
      { uuid: 'page-2', title: 'B', body: 'Text.' },
      { title: 'C', body: 'Text.' },
    ]);
    // A key is what a second run matches by. A record with none is keyed by its
    // position, which is stable only while the file is — so the count is what
    // warns somebody before they run it twice on a changing export.
    expect(candidates.map((candidate) => candidate.key)).toEqual(['page-1', 'page-2', '#2']);
    expect(positional).toBe(1);
  });

  it('finds the records inside an object with one array, and refuses one with two', () => {
    const wrapped = read({ pages: [{ id: 'a', title: 'A', body: 'Text.' }] });
    expect(wrapped.candidates).toHaveLength(1);

    const ambiguous = read({
      pages: [{ id: 'a', title: 'A', body: 'Text.' }],
      comments: [{ id: 'b', title: 'B', body: 'Text.' }],
    });
    // Choosing one of two arrays would be choosing what to import, and getting
    // it wrong quietly is worse than saying nothing was found.
    expect(ambiguous.candidates).toEqual([]);
  });

  it('takes tags and categories however the exporter wrote them', () => {
    const { candidates } = read([
      { id: 'a', title: 'A', body: 'Text.', tags: ['Ops', 'On-Call'], categories: ['Work Notes'] },
      { id: 'b', title: 'B', body: 'Text.', tags: 'ops, on-call', category: 'Work Notes/Auth' },
    ]);
    expect(candidates[0]?.tags).toEqual(['on-call', 'ops']);
    expect(candidates[1]?.tags).toEqual(['on-call', 'ops']);
    // A category is a path here, so a name with a space in it becomes one.
    expect(candidates[0]?.categoryPaths).toEqual(['work-notes']);
    expect(candidates[1]?.categoryPaths).toEqual(['work-notes/auth']);
  });

  it('fingerprints the record as well as the text, so a moved source shows', () => {
    const [before] = read([
      { id: 'a', title: 'A', body: 'Text.', updated: '2026-01-01' },
    ]).candidates;
    const [after] = read([
      { id: 'a', title: 'A', body: 'Text.', updated: '2026-06-01' },
    ]).candidates;
    // The same knowledge, so the same content hash; a different record, so a
    // different source hash — which is the question "did my source change?"
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.sourceHash).not.toBe(before?.sourceHash);
  });

  it('answers nothing for a file that is not records at all', () => {
    expect(read('a string').candidates).toEqual([]);
    expect(read(42).candidates).toEqual([]);
    expect(read(null).candidates).toEqual([]);
  });
});
