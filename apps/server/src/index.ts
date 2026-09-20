import { defaultMigrationsFolder, runMigrations } from '@knoverge/db';
import pino from 'pino';

import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createJobs } from './jobs.ts';
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
  const services = createServices({
    databaseUrl: config.databaseUrl,
    ledgerKey: config.ledgerKey,
    tokenPepper: config.tokenPepper,
    dataDir: config.dataDir,
  });
  const database = services.database;
  database.pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  const migrationsFolder = defaultMigrationsFolder();
  const runsWorker = config.role === 'all' || config.role === 'worker';
  const jobs = runsWorker
    ? createJobs(config.databaseUrl, logger, { prune: () => services.maintenance.prune() })
    : undefined;

  const app = await buildApp({
    version: pkg.version,
    loggerInstance: logger,
    trustProxy: config.trustProxy,
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
          },
          report.unresolved.length > 0
            ? 'a change to this workspace cannot be resolved automatically; the workspace will refuse writes until an operator resolves it'
            : 'interrupted changes resolved',
        );
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

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
