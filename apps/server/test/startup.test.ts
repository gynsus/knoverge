import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { runUntilSuccess } from '../src/startup.ts';

const logger = pino({ level: 'silent' });

describe('runUntilSuccess', () => {
  it('returns true on first success without delay', async () => {
    const task = vi.fn(async () => {});
    await expect(runUntilSuccess(task, { logger, name: 't' })).resolves.toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retries with growing delays until the task succeeds', async () => {
    let calls = 0;
    const task = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
    });
    const started = Date.now();
    const ok = await runUntilSuccess(task, {
      logger,
      name: 't',
      initialDelayMs: 10,
      maxDelayMs: 20,
    });
    expect(ok).toBe(true);
    expect(task).toHaveBeenCalledTimes(3);
    // 10 ms after the first failure, 20 ms after the second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('stops when aborted and reports false', async () => {
    const controller = new AbortController();
    const task = vi.fn(async () => {
      throw new Error('never');
    });
    const run = runUntilSuccess(task, {
      logger,
      name: 't',
      initialDelayMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).resolves.toBe(false);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
