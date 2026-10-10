import { describe, expect, it } from 'vitest';

import {
  BACKUP_QUEUE,
  EMBEDDING_QUEUE,
  EXTRACTION_QUEUE,
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
      EXTRACTION_QUEUE,
      BACKUP_QUEUE,
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
      // Extraction runs whether or not a webhook can be kept: a file's text is
      // not a notification and needs no key.
      EXTRACTION_QUEUE,
      // And so does the backup queue, which asks the settings every hour
      // whether it is time. It is registered on an installation that backs
      // nothing up, because the setting is changed while the product runs and
      // a queue that appeared only once backups were on would mean restarting
      // to turn them on.
      BACKUP_QUEUE,
    ]);
  });
});
