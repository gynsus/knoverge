import { describe, expect, it } from 'vitest';

import {
  asDateInput,
  asInstant,
  hasLapsed,
  validityShape,
} from '../src/components/knowledge/validity.ts';

describe('a period between a form and a contract', () => {
  it('shows an instant as the day it falls on', () => {
    expect(asDateInput('2026-06-01T09:14:32.000Z')).toBe('2026-06-01');
  });

  it('has nothing to show for a period that is open', () => {
    expect(asDateInput(null)).toBe('');
  });

  it('reads a day back as the instant it starts at', () => {
    expect(asInstant('2026-06-01')).toBe('2026-06-01T00:00:00.000Z');
  });

  it('reads an empty field as no date at all, not as the epoch', () => {
    expect(asInstant('')).toBeNull();
    expect(asInstant('   ')).toBeNull();
  });

  it('refuses to invent a date out of something that is not one', () => {
    // A half-typed date reaches this on every keystroke in some browsers, and
    // `new Date('2026-06')` is a date somewhere nobody asked about.
    expect(asInstant('not a date')).toBeNull();
    expect(asDateInput('not a date')).toBe('');
  });
});

describe('the shape of a period', () => {
  it('is open at both ends when nothing was said', () => {
    expect(validityShape({ valid_from: null, valid_until: null })).toEqual({ kind: 'always' });
  });

  it('names the end that was given', () => {
    expect(validityShape({ valid_from: '2026-01-01T00:00:00Z', valid_until: null })).toEqual({
      kind: 'since',
      from: '2026-01-01T00:00:00Z',
    });
    expect(validityShape({ valid_from: null, valid_until: '2026-01-01T00:00:00Z' })).toEqual({
      kind: 'until',
      until: '2026-01-01T00:00:00Z',
    });
  });

  it('is a span when both were given', () => {
    expect(
      validityShape({ valid_from: '2026-01-01T00:00:00Z', valid_until: '2026-06-01T00:00:00Z' }),
    ).toEqual({ kind: 'between', from: '2026-01-01T00:00:00Z', until: '2026-06-01T00:00:00Z' });
  });
});

describe('whether a claim still holds', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');

  it('does when nothing says it stopped', () => {
    expect(hasLapsed({ valid_until: null }, now)).toBe(false);
  });

  it('does not once the end has passed', () => {
    expect(hasLapsed({ valid_until: '2026-06-01T00:00:00.000Z' }, now)).toBe(true);
  });

  it('still does while the end is ahead', () => {
    expect(hasLapsed({ valid_until: '2027-01-01T00:00:00.000Z' }, now)).toBe(false);
  });

  it('has lapsed at the instant it names, because the end is the end', () => {
    expect(hasLapsed({ valid_until: '2026-09-26T12:00:00.000Z' }, now)).toBe(true);
  });
});
