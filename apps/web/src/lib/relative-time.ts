/** Largest first, so the biggest unit that fits is the one chosen. */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/**
 * "12 minutes ago", in whatever language is showing.
 *
 * `Intl.RelativeTimeFormat` rather than a catalogue of phrases: the plural
 * rules and the wording are the platform's, so Russian gets "12 минут назад"
 * and "1 минуту назад" without either being written down anywhere. `numeric:
 * 'auto'` is what turns a day into "yesterday" instead of "1 day ago".
 */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const elapsed = new Date(iso).getTime() - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(elapsed) >= ms) return format.format(Math.round(elapsed / ms), unit);
  }
  // Under a minute. "now" rather than "0 seconds ago", which reads as a fault.
  return format.format(0, 'second');
}
