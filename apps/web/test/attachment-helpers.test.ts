import { describe, expect, it } from 'vitest';

import { readableSize, toneOf } from '../src/components/files/attachment.ts';

describe('how a file’s state is shown', () => {
  it('is loud only for a failure', () => {
    expect(toneOf('failed')).toBe('destructive');
    // A file nothing here can read is an answer, not a problem: it is kept, it
    // can be downloaded, and a later version may learn to read it. Colouring it
    // like a failure spends a reader's alarm on a state nobody has to act on.
    expect(toneOf('unsupported')).not.toBe('destructive');
    expect(toneOf('pending')).not.toBe('destructive');
    expect(toneOf('proposed')).not.toBe('destructive');
  });

  it('marks out the one state that means the work is done', () => {
    expect(toneOf('extracted')).toBe('default');
    expect(toneOf('extracting')).toBe('outline');
  });
});

describe('a size a person reads', () => {
  it('counts the way the limit is written', () => {
    // The operator sets 25 MB; at the edge of it they should see 25 MB, not 26.2.
    expect(readableSize(25 * 1024 * 1024)).toBe('25 MB');
    expect(readableSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(readableSize(1536)).toBe('1.5 KB');
  });

  it('leaves small files in bytes, where a decimal would be noise', () => {
    expect(readableSize(0)).toBe('0 B');
    expect(readableSize(512)).toBe('512 B');
  });
});
