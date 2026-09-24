import { describe, expect, it } from 'vitest';

import { MAX_CHUNK_CHARS, TARGET_CHUNK_CHARS, chunkBody } from '../src/index.ts';

const paragraph = (chars: number, word = 'word') =>
  Array.from({ length: Math.ceil(chars / (word.length + 1)) }, () => word).join(' ');

describe('chunking a body', () => {
  it('keeps a short item whole', () => {
    const body = 'One assertion.\n\nAnd the reason for it.';
    expect(chunkBody(body)).toEqual([{ ordinal: 0, text: body }]);
  });

  it('merges small paragraphs rather than making a chunk of each', () => {
    const body = ['First.', 'Second.', 'Third.'].join('\n\n');
    expect(chunkBody(body)).toHaveLength(1);
  });

  it('starts a new chunk when the next paragraph would overflow the target', () => {
    const body = [paragraph(500), paragraph(500)].join('\n\n');
    const chunks = chunkBody(body);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('splits a paragraph over the ceiling on sentence ends', () => {
    const sentence = `${paragraph(300)}.`;
    const body = [sentence, sentence, sentence, sentence, sentence].join(' ');
    const chunks = chunkBody(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // Nothing is lost: every sentence is still in there somewhere.
    expect(chunks.map((c) => c.text).join(' ')).toContain(paragraph(300));
  });

  it('splits a sentence that has no end, because something has to give', () => {
    // A table row, a minified blob, or a language this does not understand.
    const chunks = chunkBody('x'.repeat(MAX_CHUNK_CHARS * 2 + 50));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.map((c) => c.text).join('').length).toBe(MAX_CHUNK_CHARS * 2 + 50);
  });

  it('never cuts inside a character', () => {
    // Emoji are surrogate pairs in UTF-16: cutting by index splits one in half
    // and puts a lone surrogate in each chunk.
    //
    // The single leading letter is what makes this a real test. Without it the
    // pairs sit at even offsets, the ceiling is even, and a cut by UTF-16 unit
    // lands between pairs by luck rather than by design.
    const body = `a${'🙂'.repeat(MAX_CHUNK_CHARS + 20)}`;
    const chunks = chunkBody(body);
    for (const chunk of chunks) {
      expect(
        [...chunk.text].some((c) => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff),
      ).toBe(false);
    }
    expect(chunks.map((c) => c.text).join('')).toBe(body);
  });

  it('answers the same way twice, which is what makes a rebuild a rebuild', () => {
    const body = [paragraph(700), paragraph(200), `${paragraph(900)}.`].join('\n\n');
    expect(chunkBody(body)).toEqual(chunkBody(body));
  });

  it('ignores blank lines and trailing whitespace', () => {
    const chunks = chunkBody('\n\n  First.  \n\n\n\n  Second.  \n\n');
    expect(chunks).toEqual([{ ordinal: 0, text: 'First.\n\nSecond.' }]);
  });

  it('has nothing to say about an empty body', () => {
    expect(chunkBody('')).toEqual([]);
    expect(chunkBody('   \n\n  ')).toEqual([]);
  });

  it('aims at the target without treating it as a ceiling', () => {
    // The target is where a chunk stops taking more, not a limit it may not
    // exceed: a paragraph larger than the target is still one chunk.
    const chunks = chunkBody(paragraph(TARGET_CHUNK_CHARS + 200));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.length).toBeGreaterThan(TARGET_CHUNK_CHARS);
  });
});
