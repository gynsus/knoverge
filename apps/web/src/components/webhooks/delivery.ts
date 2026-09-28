import type { WebhookSummary } from '@knoverge/contracts';

/**
 * What an endpoint is doing, as one word the screen can lead a row with.
 *
 * Derived here rather than stored, like every other state in this product: the
 * server already says whether the endpoint is on, how many attempts failed in a
 * row and when it was last heard, and a stored fourth field could disagree with
 * the three it was derived from.
 */
export type Standing = 'disabled' | 'failing' | 'delivering' | 'waiting';

export function standingOf(webhook: WebhookSummary): Standing {
  if (webhook.status === 'disabled') return 'disabled';
  if (webhook.failures > 0) return 'failing';
  // Told nothing yet is not the same as working: a URL that was typed wrong an
  // hour ago and has had nothing to deliver since looks exactly like a healthy
  // endpoint in a quiet workspace, and saying "delivering" of it would be a
  // claim nothing supports.
  return webhook.last_delivery_at === null ? 'waiting' : 'delivering';
}

/**
 * Whether the delivery travels in clear.
 *
 * `http` is allowed — a receiver on the same machine is a real case — and it is
 * worth saying out loud, because what leaves is signed but not encrypted.
 */
export function isPlaintext(url: string): boolean {
  return url.startsWith('http://');
}
