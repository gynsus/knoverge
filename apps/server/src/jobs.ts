import { PgBoss } from 'pg-boss';
import type pino from 'pino';

export const JOBS_SCHEMA = 'pgboss';

/**
 * Background job runner (pg-boss on PostgreSQL). Queues are registered by the
 * milestones that need them; Milestone 0 only starts and stops the runner.
 */
export interface Jobs {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the runner can reach its schema; rejects otherwise. */
  ping(): Promise<void>;
}

export function createJobs(connectionString: string, logger: pino.Logger): Jobs {
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
      started = true;
      logger.info({ schema: JOBS_SCHEMA }, 'job runner started');
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
