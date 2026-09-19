import { createHmac } from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';

export const HASH_PREFIX = 'hmac-sha256:';

/** Ledger key material. Kept out of the database; see ADR 0007. */
export type LedgerKey = { readonly bytes: Buffer };

export const MIN_LEDGER_KEY_BYTES = 32;

/**
 * Parses KNOVERGE_LEDGER_KEY (hex encoded, at least 32 bytes).
 */
export function parseLedgerKey(hex: string): LedgerKey {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new Error('ledger key must be hex encoded');
  }
  const bytes = Buffer.from(trimmed, 'hex');
  if (bytes.length < MIN_LEDGER_KEY_BYTES) {
    throw new Error(`ledger key must be at least ${MIN_LEDGER_KEY_BYTES} bytes`);
  }
  return { bytes };
}

function hmac(key: LedgerKey, ...parts: (string | Buffer)[]): string {
  const h = createHmac('sha256', key.bytes);
  for (const part of parts) h.update(part);
  return `${HASH_PREFIX}${h.digest('hex')}`;
}

/** prev_event_hash of the first event in a workspace. */
export function genesisHash(key: LedgerKey): string {
  return hmac(key, '');
}

/**
 * event_hash = HMAC-SHA256(key, prev_event_hash || canonical_json(event without event_hash))
 */
export function computeEventHash(
  key: LedgerKey,
  prevEventHash: string,
  eventWithoutHash: Record<string, unknown>,
): string {
  return hmac(key, prevEventHash, canonicalJson(eventWithoutHash));
}
