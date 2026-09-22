import { describe, expect, it } from 'vitest';

import { GENERATED_PASSWORD_LENGTH, generatePassword } from '../src/lib/password.ts';

describe('generating a password', () => {
  it('is long enough for the contract and then some', () => {
    // The server refuses anything under twelve characters.
    expect(GENERATED_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    expect(generatePassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
    expect(generatePassword(16)).toHaveLength(16);
  });

  it('never repeats itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });

  it('leaves out the characters nobody can tell apart', () => {
    // The password can be revealed, so somebody will read it off a screen.
    const generated = Array.from({ length: 100 }, () => generatePassword()).join('');
    for (const confusable of ['l', 'I', 'O', '0', '1']) {
      expect(generated, confusable).not.toContain(confusable);
    }
  });

  it('draws from the whole alphabet rather than its first block', () => {
    // A modulo over a random byte would make the first few characters of the
    // alphabet likelier than the rest; this would catch that skew.
    const counts = new Map<string, number>();
    for (const c of Array.from({ length: 500 }, () => generatePassword()).join('')) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const frequencies = [...counts.values()];
    const most = Math.max(...frequencies);
    const least = Math.min(...frequencies);
    expect(counts.size).toBeGreaterThan(60);
    expect(most / least).toBeLessThan(2);
  });
});
