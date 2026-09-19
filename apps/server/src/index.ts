import { createDatabase, defaultMigrationsFolder, runMigrations } from '@knoverge/db';
import pino from 'pino';

import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createJobs } from './jobs.ts';
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
  const database = createDatabase({ connectionString: config.databaseUrl, max: 10 });
  database.pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  const migrationsFolder = defaultMigrationsFolder();
  if (config.autoMigrate) {
    const result = await runMigrations(database.db, migrationsFolder);
    logger.info(
      { applied: result.after.applied - result.before.applied, total: result.after.total },
      'database migrations applied',
    );
  }

  const runsWorker = config.role === 'all' || config.role === 'worker';
  const jobs = runsWorker ? createJobs(config.databaseUrl, logger) : undefined;
  if (jobs) {
    await jobs.start();
  }

  const app = buildApp({
    version: pkg.version,
    loggerInstance: logger,
    trustProxy: config.trustProxy,
    ...(config.webDist ? { webDist: config.webDist } : {}),
    probes: {
      database: createDatabaseProbe(database.pool),
      dataDir: createDataDirProbe(config.dataDir),
      migrations: createMigrationsProbe(database.db, migrationsFolder),
      ...(jobs ? { jobs: createJobsProbe(jobs) } : {}),
    },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await jobs?.stop();
    await database.close();
    process.exit(0);
  };
  process.once('SIGTERM', (s) => void shutdown(s));
  process.once('SIGINT', (s) => void shutdown(s));

  await app.listen({ port: config.port, host: config.host });
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
