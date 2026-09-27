import { describe, expect, it } from 'vitest';

import { open, parseEncryptionKey, seal } from '../src/index.ts';

const key = parseEncryptionKey('ab'.repeat(32));
const other = parseEncryptionKey('cd'.repeat(32));

describe('a secret the server has to read again', () => {
  it('comes back as it went in', () => {
    const secret = 'whsec_' + 'x'.repeat(43);
    expect(open(key, seal(key, secret))).toBe(secret);
  });

  it('looks different every time, so equal secrets are not visible in the table', () => {
    // Two webhooks sharing a secret would otherwise be obvious to anybody who
    // could read the column.
    expect(seal(key, 'same')).not.toBe(seal(key, 'same'));
  });

  it('refuses a ciphertext another key sealed', () => {
    expect(() => open(other, seal(key, 'secret'))).toThrow();
  });

  it('refuses a row somebody edited', () => {
    const sealed = seal(key, 'secret');
    const [head, tag, body] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    // The tag is what makes this a refusal rather than a different plaintext.
    expect(() => open(key, `${head}.${tag}.${flipped.toString('base64url')}`)).toThrow();
  });

  it('refuses a key of the wrong size, rather than padding it', () => {
    expect(() => parseEncryptionKey('ab'.repeat(16))).toThrow(/exactly 32 bytes/u);
    expect(() => parseEncryptionKey('not hex')).toThrow(/hex/u);
  });
});
