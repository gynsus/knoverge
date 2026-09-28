import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_QUEUE,
  MAINTENANCE_QUEUE,
  SYNC_REFINE_QUEUE,
  WEBHOOK_QUEUE,
  startedQueues,
} from '../src/jobs.ts';

describe('the line that says the job runner started', () => {
  it('names the webhook queue when this process is delivering', () => {
    // Found on a running installation: the key was set, the schedule existed in
    // pg-boss, and the log still listed three queues — so the one thing an
    // operator checks after configuring a webhook said it was not running.
    expect(startedQueues(true)).toEqual([
      MAINTENANCE_QUEUE,
      SYNC_REFINE_QUEUE,
      EMBEDDING_QUEUE,
      `${EMBEDDING_QUEUE}.sweep`,
      WEBHOOK_QUEUE,
    ]);
  });

  it('leaves it out when it is not, because then it is not started', () => {
    // The sweep is a queue of its own and is scheduled like one, so a log that
    // left it out would not match what `pgboss.schedule` holds either.
    expect(startedQueues(false)).toEqual([
      MAINTENANCE_QUEUE,
      SYNC_REFINE_QUEUE,
      EMBEDDING_QUEUE,
      `${EMBEDDING_QUEUE}.sweep`,
    ]);
  });
});
