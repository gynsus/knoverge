import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, base64url (43 characters). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored; the token itself is shown or set once. */
export function hashToken(token: string, pepper?: string): string {
  const h = createHash('sha256');
  if (pepper) h.update(pepper);
  h.update(token);
  return `sha256:${h.digest('hex')}`;
}

export function tokenHashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
