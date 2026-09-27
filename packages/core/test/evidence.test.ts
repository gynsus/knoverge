import type { FrontmatterSource } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import { evidenceFrom } from '../src/index.ts';

const at = (uri: string, over: Partial<FrontmatterSource> = {}): FrontmatterSource => ({
  type: 'web_url',
  uri,
  role: 'primary',
  ...over,
});

describe('what a claim rests on', () => {
  it('is nothing when no source can be checked', () => {
    // Naming yourself is not a source: who wrote this is already recorded.
    expect(evidenceFrom([])).toBe('none');
    expect(evidenceFrom([{ type: 'human_input', role: 'primary' }])).toBe('none');
    expect(evidenceFrom([{ type: 'agent_session', client: 'claude-code', role: 'primary' }])).toBe(
      'none',
    );
  });

  it('is source-backed on one locator, and on one fingerprint', () => {
    expect(evidenceFrom([at('https://example.com/adr-4')])).toBe('source_backed');
    expect(evidenceFrom([{ type: 'file', content_hash: 'sha256:abc', role: 'primary' }])).toBe(
      'source_backed',
    );
  });

  it('is corroborated by two sources from different origins', () => {
    expect(evidenceFrom([at('https://example.com/a'), at('https://other.example.org/b')])).toBe(
      'corroborated',
    );
  });

  it('is not corroborated by one publisher agreeing with itself', () => {
    // The most likely way to reach the value at all: an agent citing three
    // sections of one document. Counting entries would call that independent.
    expect(
      evidenceFrom([
        at('https://example.com/doc#one'),
        at('https://example.com/doc#two'),
        at('https://example.com/other-page'),
      ]),
    ).toBe('source_backed');
  });

  it('reads one host through two spellings, and two ports as two servers', () => {
    expect(evidenceFrom([at('https://Example.COM/a'), at('https://example.com/b')])).toBe(
      'source_backed',
    );
    // A different port is a different server, and the record cannot say it is
    // the same publisher.
    expect(evidenceFrom([at('https://example.com/a'), at('https://example.com:8443/b')])).toBe(
      'corroborated',
    );
  });

  it('does not count a source that argues the other way', () => {
    expect(
      evidenceFrom([
        at('https://example.com/a'),
        at('https://other.example.org/b', { role: 'contradicting' }),
      ]),
    ).toBe('source_backed');
  });

  it('does not count a source derived from another', () => {
    // `derived` came out of one of these, so it cannot be independent of it.
    expect(
      evidenceFrom([
        at('https://example.com/a'),
        at('https://other.example.org/b', { role: 'derived' }),
      ]),
    ).toBe('source_backed');
  });

  it('counts a supporting source, which is what supporting means', () => {
    expect(
      evidenceFrom([
        at('https://example.com/a'),
        at('https://other.example.org/b', { role: 'supporting' }),
      ]),
    ).toBe('corroborated');
  });

  it('treats a path, a commit and an external key as their own origins', () => {
    // Not URLs, so there is no host to read and the locator is the best
    // identity there is.
    expect(
      evidenceFrom([
        { type: 'file', uri: 'docs/ARCHITECTURE.md', role: 'primary' },
        { type: 'git_commit', uri: 'abc123', role: 'primary' },
      ]),
    ).toBe('corroborated');
    expect(
      evidenceFrom([
        { type: 'file', uri: 'docs/ARCHITECTURE.md', role: 'primary' },
        { type: 'file', uri: 'docs/ARCHITECTURE.md', role: 'primary' },
      ]),
    ).toBe('source_backed');
  });

  it('counts two different fingerprints and not the same one twice', () => {
    expect(
      evidenceFrom([
        { type: 'file', content_hash: 'sha256:aaa', role: 'primary' },
        { type: 'file', content_hash: 'sha256:bbb', role: 'primary' },
      ]),
    ).toBe('corroborated');
    expect(
      evidenceFrom([
        { type: 'file', content_hash: 'sha256:aaa', role: 'primary' },
        { type: 'email', content_hash: 'sha256:aaa', role: 'primary' },
      ]),
    ).toBe('source_backed');
  });

  it('is the locator that decides, not the type', () => {
    // Two independent write-ups of one decision are both web pages, and
    // refusing to call that corroboration would leave the value unreachable.
    expect(evidenceFrom([at('https://one.example.com/x'), at('https://two.example.com/y')])).toBe(
      'corroborated',
    );
  });
});
