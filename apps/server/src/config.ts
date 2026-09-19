import { resolve } from 'node:path';

import { parseLedgerKey, type LedgerKey } from '@knoverge/core';
import { z } from 'zod';

const EnvSchema = z.object({
  KNOVERGE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  KNOVERGE_HOST: z.string().min(1).default('127.0.0.1'),
  KNOVERGE_ROLE: z.enum(['all', 'web', 'worker']).default('all'),
  KNOVERGE_DATABASE_URL: z
    .string()
    .min(1, 'KNOVERGE_DATABASE_URL is required')
    .refine(
      (v) => /^postgres(ql)?:\/\//.test(v),
      'KNOVERGE_DATABASE_URL must be a postgres:// URL',
    ),
  KNOVERGE_DATA_DIR: z.string().min(1).default('./data'),
  KNOVERGE_LEDGER_KEY: z.string().min(1, 'KNOVERGE_LEDGER_KEY is required'),
  KNOVERGE_SESSION_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64,}$/, 'KNOVERGE_SESSION_SECRET must be hex, at least 32 bytes'),
  KNOVERGE_BASE_URL: z.string().url().default('http://localhost:3000'),
  KNOVERGE_WEB_DIST: z.string().min(1).optional(),
  KNOVERGE_AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  KNOVERGE_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  KNOVERGE_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export interface Config {
  port: number;
  host: string;
  role: 'all' | 'web' | 'worker';
  databaseUrl: string;
  dataDir: string;
  /** HMAC key of the event ledger (ADR 0007). */
  ledgerKey: LedgerKey;
  /** Signs cookies (CSRF). */
  sessionSecret: string;
  baseUrl: URL;
  /** Secure cookies when the public base URL is https. */
  cookieSecure: boolean;
  /** Directory with the built web bundle; undefined disables static serving. */
  webDist: string | undefined;
  /** Apply pending migrations on start. Disable when an operator runs `knoverge db migrate`. */
  autoMigrate: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  trustProxy: boolean;
  nodeEnv: 'development' | 'test' | 'production';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Reads and validates KNOVERGE_* variables. Throws ConfigError with every problem listed.
 *
 * The host defaults to loopback (local trusted mode); containers set 0.0.0.0 explicitly.
 * A relative data directory resolves against the process working directory.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const e = result.data;
  let ledgerKey: LedgerKey;
  try {
    ledgerKey = parseLedgerKey(e.KNOVERGE_LEDGER_KEY);
  } catch (err) {
    throw new ConfigError(
      `Invalid configuration:\nKNOVERGE_LEDGER_KEY: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    port: e.KNOVERGE_PORT,
    host: e.KNOVERGE_HOST,
    role: e.KNOVERGE_ROLE,
    databaseUrl: e.KNOVERGE_DATABASE_URL,
    dataDir: resolve(e.KNOVERGE_DATA_DIR),
    ledgerKey,
    sessionSecret: e.KNOVERGE_SESSION_SECRET,
    baseUrl: new URL(e.KNOVERGE_BASE_URL),
    cookieSecure: new URL(e.KNOVERGE_BASE_URL).protocol === 'https:',
    webDist: e.KNOVERGE_WEB_DIST === undefined ? undefined : resolve(e.KNOVERGE_WEB_DIST),
    autoMigrate: e.KNOVERGE_AUTO_MIGRATE,
    logLevel: e.KNOVERGE_LOG_LEVEL,
    trustProxy: e.KNOVERGE_TRUST_PROXY,
    nodeEnv: e.NODE_ENV,
  };
}
