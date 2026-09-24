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
 * Where chunks get their vectors.
 *
 * Away from the request because it calls somebody else's server, which may be
 * slow, down, or a local model on a busy machine. A knowledge write must not
 * wait for it, and search answers lexically until the pass catches up.
 */
export const EMBEDDING_QUEUE = 'search.embed';

/**
 * Often enough that a workspace catches up on its own after a restart or a
 * model change, rarely enough that an idle installation is idle.
 */
const EMBEDDING_SCHEDULE = '*/5 * * * *';

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
  /**
   * Embeds a batch of the workspace's chunks and says how many are left, so
   * the runner can come straight back rather than wait for the schedule.
   */
  embed: (workspaceId: string) => Promise<{ embedded: number; remaining: number }>;
  /** Every workspace, for the sweep that catches up after a restart. */
  workspaces: () => Promise<string[]>;
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
      await boss.createQueue(EMBEDDING_QUEUE);
      await boss.work<{ workspaceId: string }>(EMBEDDING_QUEUE, async (jobs) => {
        for (const job of jobs) {
          const result = await options.embed(job.data.workspaceId);
          if (result.embedded > 0) {
            logger.info({ ...job.data, ...result }, 'chunks embedded');
          }
          // Straight back for the next batch rather than waiting five
          // minutes: a workspace being re-embedded should finish today.
          if (result.remaining > 0) await boss.send(EMBEDDING_QUEUE, job.data);
        }
      });
      // A sweep rather than a fill: it asks every workspace whether it has
      // anything outstanding, which is how one catches up after a restart, a
      // model change, or a provider that was down when the write happened.
      await boss.work(`${EMBEDDING_QUEUE}.sweep`, async () => {
        for (const workspaceId of await options.workspaces()) {
          await boss.send(EMBEDDING_QUEUE, { workspaceId });
        }
      });
      await boss.createQueue(`${EMBEDDING_QUEUE}.sweep`);
      await boss.schedule(`${EMBEDDING_QUEUE}.sweep`, EMBEDDING_SCHEDULE);

      started = true;
      logger.info(
        { schema: JOBS_SCHEMA, queues: [MAINTENANCE_QUEUE, SYNC_REFINE_QUEUE, EMBEDDING_QUEUE] },
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
