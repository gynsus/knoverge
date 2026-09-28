import type { ExtractionState } from '@knoverge/contracts';

/**
 * The tone a state is shown in, and nothing else.
 *
 * Only a failure is loud. `unsupported` is an answer rather than a problem — the
 * file is kept and can be downloaded — and colouring it would spend a reader's
 * alarm on a state nobody has to act on.
 */
export function toneOf(state: ExtractionState): 'default' | 'destructive' | 'outline' {
  if (state === 'failed') return 'destructive';
  if (state === 'extracted') return 'default';
  return 'outline';
}

/**
 * A size a person reads, from a number a computer counts in.
 *
 * Powers of two, because that is what the limit is expressed in: an operator who
 * set 25 MB should see 25 MB at the edge of it, not 26.2.
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
