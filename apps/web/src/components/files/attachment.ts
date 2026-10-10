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
