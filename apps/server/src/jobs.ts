import { PgBoss } from 'pg-boss';
import type pino from 'pino';
import type { MaintenanceResult } from '@knoverge/core';

export const JOBS_SCHEMA = 'pgboss';

/** The queue that removes rows nothing reads any more. */
export const MAINTENANCE_QUEUE = 'maintenance.prune';

/** Once an hour. The rows it removes are already useless, so this is not urgent. */
const MAINTENANCE_SCHEDULE = '0 * * * *';

/**
 * Background job runner (pg-boss on PostgreSQL). Queues are registered by the
 * milestones that need them.
 */
export interface Jobs {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the runner can reach its schema; rejects otherwise. */
  ping(): Promise<void>;
}

export interface JobsOptions {
  /** Runs on a schedule and when an operator asks for it. */
  prune: () => Promise<MaintenanceResult>;
}

export function createJobs(
  connectionString: string,
  logger: pino.Logger,
  options: JobsOptions,
): Jobs {
  const boss = new PgBoss({
    connectionString,
    schema: JOBS_SCHEMA,
    max: 3,
  });
  boss.on('error', (err: Error) => logger.error({ err }, 'job runner error'));
  let started = false;

  return {
    async start() {
      if (started) return;
      await boss.start();
      await boss.createQueue(MAINTENANCE_QUEUE);
      await boss.work(MAINTENANCE_QUEUE, async () => {
        const removed = await options.prune();
        logger.info(removed, 'maintenance pruned expired rows');
      });
      // Idempotent: scheduling the same queue again replaces the schedule, so
      // several workers do not multiply it.
      await boss.schedule(MAINTENANCE_QUEUE, MAINTENANCE_SCHEDULE);
      started = true;
      logger.info({ schema: JOBS_SCHEMA, queue: MAINTENANCE_QUEUE }, 'job runner started');
    },
    async stop() {
      if (!started) return;
      await boss.stop({ graceful: true, timeout: 10_000 });
      started = false;
      logger.info('job runner stopped');
    },
    async ping() {
      if (!started) {
        throw new Error('job runner not started');
      }
      await boss.getQueues();
    },
  };
}
