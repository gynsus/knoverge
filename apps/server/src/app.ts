import { randomUUID } from 'node:crypto';

import type { ReadyResponse } from '@knoverge/contracts';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { ReadinessProbes } from './probes.ts';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Uses a well-formed client request id, otherwise generates one. Arbitrary header
 * values never reach the logs.
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export interface AppOptions {
  version: string;
  probes: ReadinessProbes;
  loggerInstance?: FastifyBaseLogger;
  trustProxy?: boolean;
}

/**
 * Builds the Fastify instance. Transport only: no domain logic lives here.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const common = {
    trustProxy: options.trustProxy ?? false,
    requestIdHeader: false as const,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) =>
      resolveRequestId(req.headers['x-request-id']),
  };
  const app = options.loggerInstance
    ? Fastify({ ...common, loggerInstance: options.loggerInstance })
    : Fastify({ ...common, logger: false });

  app.get('/health/live', async () => ({ status: 'ok' as const }));

  app.get('/health/ready', async (_request, reply) => {
    const [database, dataDir] = await Promise.all([
      options.probes.database(),
      options.probes.dataDir(),
    ]);
    const healthy = database.status === 'ok' && dataDir.status === 'ok';
    const body: ReadyResponse = {
      status: healthy ? 'ok' : 'degraded',
      version: options.version,
      checks: { database, data_dir: dataDir },
    };
    reply.code(healthy ? 200 : 503);
    return body;
  });

  return app;
}
