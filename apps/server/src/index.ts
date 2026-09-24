import type { WorkspaceId } from '@knoverge/contracts';
import { defaultMigrationsFolder, runMigrations } from '@knoverge/db';
import pino from 'pino';

import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { refineSyncSession } from './refine.ts';
import { createJobs, type Jobs } from './jobs.ts';
import { createServices } from './services.ts';
import { runUntilSuccess } from './startup.ts';
import {
  createDatabaseProbe,
  createDataDirProbe,
  createJobsProbe,
  createMigrationsProbe,
} from './probes.ts';

function createLogger(level: string, nodeEnv: string): pino.Logger {
  if (nodeEnv === 'development') {
    return pino({ level, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino({ level });
}

/** Shorter than the ten seconds Docker allows between SIGTERM and SIGKILL. */
const SHUTDOWN_DEADLINE_MS = 8_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel, config.nodeEnv);
  // The runner needs the services to settle a session and the services need
  // the runner to ask for it. The holder is how the two are tied without a
  // cycle: the closure reads it when a request arrives, long after both exist.
  const runner: { jobs: Jobs | undefined } = { jobs: undefined };
  const services = createServices({
    // Keys stay in the environment (ADR 0021). This is how one reaches the
    // provider it was meant for without ever being stored.
    apiKeyFor: (baseUrl) =>
      config.embeddings && trimSlashes(config.embeddings.baseUrl) === trimSlashes(baseUrl)
        ? config.embeddings.apiKey
        : undefined,
    enqueueRefine: async (workspaceId, sessionId) => {
      await runner.jobs?.refineSync(workspaceId, sessionId);
    },
    // An idle connection dying is the operator's business, not a caller's, and
    // must not end the process.
    onPoolError: (error) => logger.warn({ err: error }, 'a pooled connection failed while idle'),
    // The provider being down costs the semantic half of a search, not the
    // search. An operator has to be able to see that it happened.
    onSemanticFailure: (workspaceId, error) =>
      logger.warn(
        { err: error, workspaceId },
        'semantic search is unavailable; answering lexically',
      ),
    databaseUrl: config.databaseUrl,
    ledgerKey: config.ledgerKey,
    tokenPepper: config.tokenPepper,
    dataDir: config.dataDir,
    version: pkg.version,
  });
  const database = services.database;

  const migrationsFolder = defaultMigrationsFolder();
  const runsWorker = config.role === 'all' || config.role === 'worker';
  runner.jobs = runsWorker
    ? createJobs(config.databaseUrl, logger, {
        prune: () => services.maintenance.prune(),
        refineSync: (workspaceId, sessionId) => refineSyncSession(services, workspaceId, sessionId),
        embed: (workspaceId) => services.embeddings.fill(workspaceId as WorkspaceId),
        workspaces: async () =>
          (await services.repositories.workspaces.list()).map((workspace) => workspace.id),
      })
    : undefined;
  const jobs = runner.jobs;

  const app = await buildApp({
    version: pkg.version,
    loggerInstance: logger,
    trustProxy: config.trustProxy,
    agentBudgets: config.agentBudgets,
    ...(config.webDist ? { webDist: config.webDist } : {}),
    services,
    security: { sessionSecret: config.sessionSecret, cookieSecure: config.cookieSecure },
    probes: {
      database: createDatabaseProbe(database.pool),
      dataDir: createDataDirProbe(config.dataDir),
      migrations: createMigrationsProbe(database.db, migrationsFolder),
      ...(jobs ? { jobs: createJobsProbe(jobs) } : {}),
    },
  });

  const stopping = new AbortController();
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopping.abort();
    try {
      // Bounded, because closing the pool waits for in-flight queries and a
      // migration can be one of them. Docker sends SIGKILL ten seconds after
      // SIGTERM, and being killed in the middle of a migration is worse than
      // abandoning the wait for it.
      await Promise.race([
        (async () => {
          await app.close();
          await jobs?.stop();
          await database.close();
        })(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref()),
      ]);
    } catch (error) {
      logger.error({ err: error }, 'shutdown did not complete cleanly');
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', (s) => void shutdown(s));
  process.once('SIGINT', (s) => void shutdown(s));

  // Listen first so liveness answers immediately; readiness stays degraded
  // until the database is reachable, migrated and the job runner is up.
  await app.listen({ port: config.port, host: config.host });

  void runUntilSuccess(
    async () => {
      if (config.autoMigrate) {
        const result = await runMigrations(database.db, migrationsFolder);
        logger.info(
          { applied: result.after.applied - result.before.applied, total: result.after.total },
          'database migrations applied',
        );
      }
      // Before anything is served that could write: an operation left
      // unfinished by a crash blocks its workspace, and this is what clears it.
      const reports = await services.recovery.recoverAll();
      for (const [workspaceId, report] of Object.entries(reports)) {
        const level = report.unresolved.length > 0 ? 'error' : 'warn';
        logger[level](
          {
            workspaceId,
            examined: report.examined,
            failed: report.failed,
            recovered: report.recovered,
            unresolved: report.unresolved,
            // Why, not only which: an id on its own sends an operator to the
            // database to find out what is wrong with it.
            reasons: report.reasons,
          },
          report.unresolved.length > 0
            ? 'a change to this workspace cannot be resolved automatically; the workspace will refuse writes until an operator resolves it'
            : 'interrupted changes resolved',
        );
      }
      // The environment provisions a first start and is not read again
      // (ADR 0021): an installation configured through the interface must
      // not be reset by a compose file somebody forgot to update.
      if (config.embeddings) {
        const seeded = await services.ai.seed({
          kind: config.embeddings.provider,
          baseUrl: config.embeddings.baseUrl,
          model: config.embeddings.model,
        });
        logger.info(
          { model: config.embeddings.model, seeded },
          seeded
            ? 'the embedding provider in the environment was configured'
            : 'a provider is already configured; the environment was not read',
        );
      }
      // Fills the search index for knowledge recorded before the index
      // existed, or before a restore that predates it. A feature that ships
      // an index and leaves it empty for everything already there is a
      // feature that quietly finds nothing, and an operator has no reason to
      // suspect it.
      for (const workspace of await services.repositories.workspaces.list()) {
        const result = await services.knowledge.reindex(workspace.id, { onlyMissing: true });
        if (result.indexed > 0 || result.missing > 0) {
          logger.info(
            { workspace: workspace.slug, indexed: result.indexed, missing: result.missing },
            'search index filled for knowledge it did not hold',
          );
        }
      }
      await jobs?.start();
    },
    { logger, name: 'database bootstrap', signal: stopping.signal },
  );
  logger.info(
    {
      role: config.role,
      dataDir: config.dataDir,
      webDist: config.webDist ?? null,
      worker: runsWorker,
    },
    'knoverge server started',
  );
}

/** One spelling for an address, so two forms of the same URL are one. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/u, '');
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
