import { describe, expect, it } from 'vitest';

import { extractText } from '../src/extract.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const LIMIT = 20_000;

describe('the text inside a file', () => {
  it('is the file, when the file is text', () => {
    const result = extractText(
      'text/plain; charset=utf-8',
      bytes('Support closes at five.\n'),
      LIMIT,
    );
    expect(result).toEqual({ kind: 'text', text: 'Support closes at five.' });
  });

  it('is Markdown as written, because Markdown is what an item holds anyway', () => {
    const source = '# Hours\n\nUntil five, **every** weekday.\n';
    expect(extractText('text/markdown', bytes(source), LIMIT)).toEqual({
      kind: 'text',
      text: '# Hours\n\nUntil five, **every** weekday.',
    });
  });

  it('is what somebody reads off a page, and none of the page', () => {
    const page = [
      '<html><head><style>p { color: red }</style>',
      '<script>fetch("/steal")</script></head>',
      '<body><h1>Support</h1><p>Until&nbsp;five, every weekday.</p>',
      '<p>Closed on <b>Sunday</b>.</p></body></html>',
    ].join('');
    const result = extractText('text/html', bytes(page), LIMIT);
    expect(result.kind).toBe('text');
    const text = result.kind === 'text' ? result.text : '';
    // The script and the style go with their contents: what a reader sees is
    // what an item should hold, and neither of those is read by anybody.
    expect(text).not.toContain('fetch');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('<');
    expect(text).toContain('Support');
    expect(text).toContain('Until five, every weekday.');
    expect(text).toContain('Closed on Sunday.');
  });

  it('decodes the entities a person actually writes', () => {
    const result = extractText(
      'text/html',
      bytes('<p>Tom &amp; Jerry &#8212; &quot;hi&quot;</p>'),
      LIMIT,
    );
    expect(result).toEqual({ kind: 'text', text: 'Tom & Jerry — "hi"' });
  });

  it('is nothing for a type nothing here reads', () => {
    const result = extractText('application/zip', bytes('PK\u0003\u0004'), LIMIT);
    // Not a failure: the file is kept and referred to, and a later milestone may
    // learn to read it (ADR 0008).
    expect(result.kind).toBe('unsupported');
  });

  it('is a failure for bytes that are not the text they claim to be', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const result = extractText('text/plain', jpeg, LIMIT);
    expect(result.kind).toBe('failed');
  });

  it('is a failure for an empty file, which would make an item saying nothing', () => {
    expect(extractText('text/plain', bytes('   \n\n'), LIMIT).kind).toBe('failed');
  });

  it('is a failure rather than half a document', () => {
    const long = 'Every line of a very long document.\n'.repeat(1000);
    const result = extractText('text/plain', bytes(long), 500);
    // Half a document stored as if it were the whole one is the kind of thing
    // nobody notices until they rely on it.
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.reason).toContain('500');
  });
});
