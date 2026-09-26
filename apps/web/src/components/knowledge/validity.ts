import type { KnowledgeItemDetail } from '@knoverge/contracts';

/**
 * When a claim holds, as a date somebody can read and type.
 *
 * `valid_from` and `valid_until` are instants in the contract, and a date is
 * the granularity a person states them at: "the rate changed in June", not
 * "the rate changed at 09:14:32Z". So the form edits dates, and an untouched
 * field is never sent — which is what keeps the exact instant a supersession
 * recorded from being rounded to midnight by somebody editing the title.
 */

/** An instant as the value of an `<input type="date">`. Empty when unset. */
export function asDateInput(instant: string | null): string {
  if (!instant) return '';
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '';
  return at.toISOString().slice(0, 10);
}

/**
 * A date from the form as an instant, at the start of that day, UTC.
 *
 * The empty case is checked rather than left to the parse below it. `Date`
 * parsing of anything that is not a valid ISO string is implementation-defined,
 * so `new Date('T00:00:00.000Z')` being rejected is one engine's behaviour and
 * not a guarantee. A test on one engine cannot tell the two apart.
 */
export function asInstant(date: string): string | null {
  if (date.trim() === '') return null;
  const at = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** What the period is, as one of the four shapes it can have. */
export type ValidityShape =
  | { kind: 'always' }
  | { kind: 'since'; from: string }
  | { kind: 'until'; until: string }
  | { kind: 'between'; from: string; until: string };

export function validityShape(
  item: Pick<KnowledgeItemDetail, 'valid_from' | 'valid_until'>,
): ValidityShape {
  const from = item.valid_from;
  const until = item.valid_until;
  if (from && until) return { kind: 'between', from, until };
  if (from) return { kind: 'since', from };
  if (until) return { kind: 'until', until };
  return { kind: 'always' };
}

/**
 * Whether the claim has stopped holding.
 *
 * Still `active`, and still true of the period it names — historically correct
 * information is not destroyed because the present moved on
 * (`KNOWLEDGE_MODEL.md` section 10). Saying so is the difference between an
 * item a reader can rely on and one they cannot.
 */
export function hasLapsed(
  item: Pick<KnowledgeItemDetail, 'valid_until'>,
  now: Date = new Date(),
): boolean {
  if (!item.valid_until) return false;
  const until = Date.parse(item.valid_until);
  return !Number.isNaN(until) && until <= now.getTime();
}
