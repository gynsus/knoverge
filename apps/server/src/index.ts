import { Pool } from 'pg';
import pino from 'pino';

import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createDatabaseProbe, createDataDirProbe } from './probes.ts';

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
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  const app = buildApp({
    version: pkg.version,
    loggerInstance: logger,
    trustProxy: config.trustProxy,
    ...(config.webDist ? { webDist: config.webDist } : {}),
    probes: {
      database: createDatabaseProbe(pool),
      dataDir: createDataDirProbe(config.dataDir),
    },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', (s) => void shutdown(s));
  process.once('SIGINT', (s) => void shutdown(s));

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { role: config.role, dataDir: config.dataDir, webDist: config.webDist ?? null },
    'knoverge server started',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
