import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A secret the server has to be able to read again.
 *
 * The only class of secret in this product that is recoverable: a webhook's
 * signing secret is useless as a hash, because signing is the whole point of
 * keeping it. Passwords, session tokens and agent tokens stay one-way hashed, and
 * the key for this stays in the environment, out of the database it protects.
 *
 * AES-256-GCM: the ciphertext carries its own authentication tag, so a row edited
 * in the database fails to open rather than opening to something else.
 */
export interface EncryptionKey {
  readonly bytes: Buffer;
}

export const ENCRYPTION_KEY_BYTES = 32;

/** Parses KNOVERGE_ENCRYPTION_KEY: hex, exactly 32 bytes. */
export function parseEncryptionKey(hex: string): EncryptionKey {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/u.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new Error('encryption key must be hex encoded');
  }
  const bytes = Buffer.from(trimmed, 'hex');
  if (bytes.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(`encryption key must be exactly ${ENCRYPTION_KEY_BYTES} bytes`);
  }
  return { bytes };
}

/** What a sealed secret looks like in a column: version, nonce, tag, ciphertext. */
const PREFIX = 'gcm1:';

/**
 * Seals a secret for storage.
 *
 * A fresh nonce every time, so sealing the same secret twice gives two different
 * strings: equal ciphertexts would tell anybody with the table which webhooks
 * share a secret.
 */
export function seal(key: EncryptionKey, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PREFIX + iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/**
 * Opens a sealed secret, or refuses.
 *
 * Throws rather than answering null: a secret that cannot be opened means the key
 * is wrong or the row was tampered with, and both are situations where carrying on
 * with an empty string would sign something with nothing.
 */
export function open(key: EncryptionKey, sealed: string): string {
  const [head, tag, body] = sealed.split('.');
  if (!head?.startsWith(PREFIX) || tag === undefined || body === undefined) {
    throw new Error('this secret was not sealed by this version');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key.bytes,
    Buffer.from(head.slice(PREFIX.length), 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
