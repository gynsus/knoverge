import { PgBoss } from 'pg-boss';
import type pino from 'pino';
import type { MaintenanceResult } from '@knoverge/core';

export const JOBS_SCHEMA = 'pgboss';

/** The queue that removes rows nothing reads any more. */
export const MAINTENANCE_QUEUE = 'maintenance.prune';

/** Once an hour. The rows it removes are already useless, so this is not urgent. */
const MAINTENANCE_SCHEDULE = '0 * * * *';

/**
 * Where a submitted inventory is settled.
 *
 * The deterministic steps answer inside the request; this is the similarity
 * pass, which is a trigram query per candidate and will gain a vector query
 * beside it. An agent polls `sync_get_matches` until nothing is provisional.
 */
export const SYNC_REFINE_QUEUE = 'sync.refine';

/**
 * Background job runner (pg-boss on PostgreSQL). Queues are registered by the
 * milestones that need them.
 */
export interface Jobs {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the runner can reach its schema; rejects otherwise. */
  ping(): Promise<void>;
  /**
   * Asks for a session's provisional candidates to be settled.
   *
   * Safe to ask twice: the pass only touches rows still waiting, so a second
   * job finds nothing to do. That is why a dropped one costs an agent a poll
   * rather than a wrong answer.
   */
  refineSync(workspaceId: string, sessionId: string): Promise<void>;
}

export interface JobsOptions {
  /** Runs on a schedule and when an operator asks for it. */
  prune: () => Promise<MaintenanceResult>;
  /** Settles the candidates the deterministic steps left provisional. */
  refineSync: (workspaceId: string, sessionId: string) => Promise<number>;
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

      await boss.createQueue(SYNC_REFINE_QUEUE);
      await boss.work<{ workspaceId: string; sessionId: string }>(
        SYNC_REFINE_QUEUE,
        async (jobs) => {
          for (const job of jobs) {
            const settled = await options.refineSync(job.data.workspaceId, job.data.sessionId);
            logger.info({ ...job.data, settled }, 'sync candidates refined');
          }
        },
      );
      started = true;
      logger.info(
        { schema: JOBS_SCHEMA, queues: [MAINTENANCE_QUEUE, SYNC_REFINE_QUEUE] },
        'job runner started',
      );
    },
    async stop() {
      if (!started) return;
      await boss.stop({ graceful: true, timeout: 10_000 });
      started = false;
      logger.info('job runner stopped');
    },
    async refineSync(workspaceId: string, sessionId: string) {
      if (!started) return;
      await boss.send(SYNC_REFINE_QUEUE, { workspaceId, sessionId });
    },
    async ping() {
      if (!started) {
        throw new Error('job runner not started');
      }
      await boss.getQueues();
    },
  };
}
