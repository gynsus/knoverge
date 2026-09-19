import { setTimeout as sleep } from 'node:timers/promises';

import type pino from 'pino';

export interface RetryOptions {
  logger: pino.Logger;
  /** Label used in log lines. */
  name: string;
  /** First delay after a failure, in milliseconds. */
  initialDelayMs?: number;
  /** Upper bound for the delay, in milliseconds. */
  maxDelayMs?: number;
  /** Aborts the retry loop, for example during shutdown. */
  signal?: AbortSignal;
}

/**
 * Runs a startup task until it succeeds, with exponential backoff between
 * attempts. Failures are logged and never thrown: a server whose database is
 * not yet reachable must keep answering liveness and report readiness as
 * degraded instead of crash-looping. Resolves false when aborted.
 */
export async function runUntilSuccess(
  task: () => Promise<void>,
  options: RetryOptions,
): Promise<boolean> {
  const initial = options.initialDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 30_000;
  let delay = initial;
  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted) return false;
    attempt += 1;
    try {
      await task();
      if (attempt > 1) {
        options.logger.info({ task: options.name, attempt }, 'startup task succeeded after retry');
      }
      return true;
    } catch (err) {
      options.logger.error(
        { err, task: options.name, attempt, retryInMs: delay },
        'startup task failed; retrying',
      );
    }
    try {
      await sleep(delay, undefined, options.signal ? { signal: options.signal } : {});
    } catch {
      return false;
    }
    delay = Math.min(delay * 2, max);
  }
}
