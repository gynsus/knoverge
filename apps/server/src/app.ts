import { randomUUID } from 'node:crypto';

import fastifyStatic from '@fastify/static';

import type { ReadyResponse } from '@knoverge/contracts';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerActorDecorators } from './plugins/actor-decorators.ts';
import { registerAgentContext } from './plugins/agent-context.ts';
import { registerAuthContext } from './plugins/auth-context.ts';
import { NOT_FOUND, registerErrorHandler } from './plugins/errors.ts';
import { registerSecurity, type SecurityOptions } from './plugins/security.ts';
import type { ReadinessProbes } from './probes.ts';
import { registerAdminAgentRoutes } from './routes/admin-agents.ts';
import { registerAdminPolicyRoutes } from './routes/admin-policy.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerTaxonomyRoutes } from './routes/taxonomy.ts';
import { registerOpenApi } from './routes/openapi.ts';
import type { Services } from './services.ts';

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
  /** Built web bundle to serve at '/', with SPA fallback for unknown paths. */
  webDist?: string;
  /** Domain services; when present the API routes and security plugins are registered. */
  services?: Services;
  security?: SecurityOptions;
}

const API_PREFIXES = ['/v1/', '/mcp', '/health/'];

/**
 * Builds the Fastify instance. Transport only: no domain logic lives here.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const common = {
    trustProxy: options.trustProxy ?? false,
    requestIdHeader: false as const,
    bodyLimit: 1_048_576,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) =>
      resolveRequestId(req.headers['x-request-id']),
  };
  const app = options.loggerInstance
    ? Fastify({ ...common, loggerInstance: options.loggerInstance })
    : Fastify({ ...common, logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.get('/health/live', async () => ({ status: 'ok' as const }));

  app.get('/health/ready', async (_request, reply) => {
    const [database, dataDir, migrations, jobs] = await Promise.all([
      options.probes.database(),
      options.probes.dataDir(),
      options.probes.migrations?.(),
      options.probes.jobs?.(),
    ]);
    const checks: ReadyResponse['checks'] = {
      database,
      data_dir: dataDir,
      ...(migrations ? { migrations } : {}),
      ...(jobs ? { jobs } : {}),
    };
    const healthy = Object.values(checks).every((c) => c?.status === 'ok');
    const body: ReadyResponse = {
      status: healthy ? 'ok' : 'degraded',
      version: options.version,
      checks,
    };
    reply.code(healthy ? 200 : 503);
    return body;
  });

  if (options.services && options.security) {
    await registerSecurity(app, options.security);
    await registerOpenApi(app, options.version);
    registerActorDecorators(app);
    registerAuthContext(app, options.services);
    registerAgentContext(app, options.services);
    registerAuthRoutes(app, {
      services: options.services,
      cookieSecure: options.security.cookieSecure,
    });
    registerAdminAgentRoutes(app, options.services);
    registerAdminPolicyRoutes(app, options.services);
    registerTaxonomyRoutes(app, options.services);
  }

  if (options.webDist) {
    await app.register(fastifyStatic, {
      root: options.webDist,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // Hashed assets under /assets are immutable; index.html must always be revalidated.
        const cache = filePath.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        void res.header('cache-control', cache);
      },
    });
  }

  const webDist = options.webDist;
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const isApi = API_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
    if (webDist && request.method === 'GET' && !isApi) {
      return reply
        .header('cache-control', 'no-cache')
        .sendFile('index.html', webDist, { cacheControl: false });
    }
    return reply.code(404).send(NOT_FOUND);
  });

  await app.ready();
  return app;
}
