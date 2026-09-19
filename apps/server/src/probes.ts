import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type { HealthCheck } from '@knoverge/contracts';
import type { Database } from '@knoverge/db';
import { getMigrationStatus } from '@knoverge/db';
import type { Pool } from 'pg';

import type { Jobs } from './jobs.ts';

/**
 * Readiness probes. Each returns a HealthCheck and never throws.
 */
export interface ReadinessProbes {
  database(): Promise<HealthCheck>;
  dataDir(): Promise<HealthCheck>;
  migrations?(): Promise<HealthCheck>;
  jobs?(): Promise<HealthCheck>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function timed(run: () => Promise<void>): Promise<HealthCheck> {
  const started = performance.now();
  try {
    await run();
    return { status: 'ok', latency_ms: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      status: 'failed',
      latency_ms: Math.round(performance.now() - started),
      error: errorMessage(err),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createDatabaseProbe(pool: Pool, timeoutMs = 2000): () => Promise<HealthCheck> {
  return () =>
    timed(async () => {
      await withTimeout(pool.query('SELECT 1'), timeoutMs, 'database probe');
    });
}

export function createMigrationsProbe(
  db: Database,
  migrationsFolder: string,
): () => Promise<HealthCheck> {
  return () =>
    timed(async () => {
      const status = await withTimeout(
        getMigrationStatus(db, migrationsFolder),
        2000,
        'migrations probe',
      );
      if (status.pending.length > 0) {
        throw new Error(
          `${status.pending.length} pending migration(s): ${status.pending.join(', ')}`,
        );
      }
    });
}

export function createJobsProbe(jobs: Jobs): () => Promise<HealthCheck> {
  return () =>
    timed(async () => {
      await withTimeout(jobs.ping(), 2000, 'jobs probe');
    });
}

export function createDataDirProbe(dataDir: string): () => Promise<HealthCheck> {
  return () =>
    timed(async () => {
      await mkdir(dataDir, { recursive: true });
      await access(dataDir, constants.R_OK | constants.W_OK);
    });
}
