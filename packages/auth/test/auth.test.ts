import { describe, expect, it } from 'vitest';

import {
  dummyPasswordHash,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  tokenHashesEqual,
  verifyPassword,
} from '../src/index.ts';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('produces different hashes for the same password (salted)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });

  it('provides a stable dummy hash for constant-time login', async () => {
    expect(await dummyPasswordHash()).toBe(await dummyPasswordHash());
    expect(await verifyPassword('anything', await dummyPasswordHash())).toBe(false);
  });
});

describe('tokens', () => {
  it('generates 43-character base64url tokens', () => {
    const t = generateOpaqueToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(t);
  });

  it('hashes deterministically with an optional pepper', () => {
    expect(hashToken('t')).toBe(hashToken('t'));
    expect(hashToken('t')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashToken('t', 'p')).not.toBe(hashToken('t'));
  });

  it('compares hashes in constant time', () => {
    expect(tokenHashesEqual(hashToken('a'), hashToken('a'))).toBe(true);
    expect(tokenHashesEqual(hashToken('a'), hashToken('b'))).toBe(false);
    expect(tokenHashesEqual('short', 'longer')).toBe(false);
  });
});
