import { randomUUID } from 'node:crypto';

import type { ReadyResponse } from '@knoverge/contracts';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { ReadinessProbes } from './probes.ts';

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
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
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
