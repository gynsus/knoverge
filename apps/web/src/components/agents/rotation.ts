import type { CredentialSummary } from '@knoverge/contracts';

/** What a credential is, as the screen has to describe it. */
export type CredentialState = 'active' | 'expired' | 'revoked';

export function stateOf(credential: CredentialSummary, now = new Date()): CredentialState {
  if (credential.revoked_at) return 'revoked';
  if (credential.expires_at !== null && new Date(credential.expires_at) <= now) return 'expired';
  return 'active';
}

/**
 * Where one credential stands in a rotation.
 *
 * Rotation is issue, then revoke, in that order, and deliberately not one
 * operation: something would have to decide when the old token stops working, and
 * an agent holding a token revoked before it was given the new one is worse than
 * two live tokens for a minute (`DEPLOYMENT.md`).
 *
 * What an operator is missing at that moment is the one fact that says the second
 * step is safe: whether the agent has used the old token since the new one exists.
 * It is in the list already — the old one's `last_used_at` against the new one's
 * `created_at` — and nothing was reading it.
 */
export type RotationStanding =
  /** The newest live credential. Revoking this is what breaks a working agent. */
  | { kind: 'current' }
  /** A live credential with a newer one beside it, not used since that one appeared. */
  | { kind: 'superseded'; by: string }
  /** A live credential with a newer one beside it, still being used. */
  | { kind: 'still_in_use'; by: string; lastUsedAt: string }
  /** Revoked or expired: nothing to decide. */
  | { kind: 'finished' };

export function standingOf(
  credential: CredentialSummary,
  all: readonly CredentialSummary[],
  now = new Date(),
): RotationStanding {
  if (stateOf(credential, now) !== 'active') return { kind: 'finished' };
  const newer = all
    .filter((other) => other.id !== credential.id && stateOf(other, now) === 'active')
    .filter((other) => new Date(other.created_at) > new Date(credential.created_at))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const replacement = newer[0];
  if (!replacement) return { kind: 'current' };
  // Never used at all, or not since the replacement was issued: whatever the agent
  // is presenting, it is not this.
  if (
    credential.last_used_at === null ||
    new Date(credential.last_used_at) < new Date(replacement.created_at)
  ) {
    return { kind: 'superseded', by: replacement.token_prefix };
  }
  return {
    kind: 'still_in_use',
    by: replacement.token_prefix,
    lastUsedAt: credential.last_used_at,
  };
}
