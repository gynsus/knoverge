/**
 * A size a person reads, from a number a computer counts in.
 *
 * Powers of two, because that is what the limits are expressed in: an operator
 * who set 25 MB should see 25 MB at the edge of it, not 26.2.
 *
 * Here rather than with the files it was written for, because backups are
 * measured too and two implementations would disagree about a gigabyte.
 */
export function readableSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
