import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import { LiveResponse, ReadyResponse } from '@knoverge/contracts';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerActorDecorators } from './plugins/actor-decorators.ts';
import { registerAgentContext } from './plugins/agent-context.ts';
import { registerAuthContext } from './plugins/auth-context.ts';
import { NOT_FOUND, registerErrorHandler } from './plugins/errors.ts';
import { registerRequestLogging } from './plugins/logging.ts';
import {
  cspNonceOf,
  registerRateLimits,
  registerSecurity,
  type SecurityOptions,
} from './plugins/security.ts';
import type { ReadinessProbes } from './probes.ts';
import { registerAdminAgentRoutes } from './routes/admin-agents.ts';
import { registerConsentRoutes, registerOauthRoutes } from './routes/oauth.ts';
import { registerAdminAiRoutes } from './routes/admin-ai.ts';
import { registerAdminBackupRoutes } from './routes/admin-backups.ts';
import { registerAdminPolicyRoutes } from './routes/admin-policy.ts';
import { registerAdminAttachmentRoutes } from './routes/admin-attachments.ts';
import { registerAdminWebhookRoutes } from './routes/admin-webhooks.ts';
import { registerAdminWorkspaceRoutes } from './routes/admin-workspace.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerKnowledgeRoutes } from './routes/knowledge.ts';
import { registerProposalRoutes } from './routes/proposals.ts';
import { DEFAULT_AGENT_LIMITS, type AgentBudgets } from './plugins/agent-limits.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { registerTaxonomyRoutes } from './routes/taxonomy.ts';
import { registerToolRoutes } from './routes/tools.ts';
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
  /** Overrides the default per-actor rate limit; tests raise it. */
  rateLimit?: { max?: number; timeWindow?: string };
  /** What one agent credential may spend. Defaults where an operator said nothing. */
  agentBudgets?: AgentBudgets;
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
  const budgets = options.agentBudgets ?? DEFAULT_AGENT_LIMITS;
  // Whether the rate-limit plugin is present, which decides if routes and the
  // not-found handler can ask it for a budget.
  let limited = false;
  const app = options.loggerInstance
    ? Fastify({ ...common, loggerInstance: options.loggerInstance })
    : Fastify({ ...common, logger: false });
  // Decorated before any route is registered, so the manifest can report the
  // budgets a client should pace itself against.
  app.decorate('agentBudgets', budgets);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  if (options.services && options.security) {
    await registerSecurity(app, options.security);
    registerActorDecorators(app);
    registerAuthContext(app, options.services);
    registerAgentContext(app, options.services);
    // After the context hooks so the limiter keys on the resolved caller, and
    // before every route: the plugin gives a budget to each route as it is
    // declared, so anything registered earlier would have none at all.
    await registerRateLimits(app, options.rateLimit ?? {});
    limited = true;
    await registerOpenApi(app, options.version);
    registerRequestLogging(app);
    registerAuthRoutes(app, {
      services: options.services,
      cookieSecure: options.security.cookieSecure,
    });
    // The parser for the one route that takes a file. Its limit is the
    // installation's own: a part that runs past it is cut off, and the route
    // refuses rather than storing a file missing its end.
    await app.register(multipart, {
      limits: { fileSize: options.services.attachmentMaxBytes, files: 1, fields: 4 },
      // The parser stops reading and says the part was cut short, rather than
      // throwing its own error: the route answers with the size this
      // installation accepts, which is the one thing the uploader needs to know.
      throwFileSizeLimit: false,
    });
    // Before the admin routes so the well-known documents and /oauth/* live in
    // their own scope, with their own error shape and their own body parser.
    await registerOauthRoutes(app, options.services);
    registerConsentRoutes(app, options.services);
    registerAdminAgentRoutes(app, options.services);
    registerAdminAttachmentRoutes(app, options.services);
    registerAdminAiRoutes(app, options.services);
    registerAdminBackupRoutes(app, options.services);
    registerAdminPolicyRoutes(app, options.services);
    registerAdminWebhookRoutes(app, options.services);
    registerAdminWorkspaceRoutes(app, options.services);
    registerKnowledgeRoutes(app, options.services);
    registerProposalRoutes(app, options.services);
    registerTaxonomyRoutes(app, options.services);
    // Last, so every handler it dispatches to is defined: one POST route per
    // tool, generated from the contract (rule 11).
    registerToolRoutes(app, options.services, budgets);
    // The same tools again, over MCP. One contract, two transports (rule 11).
    registerMcpRoutes(app, options.services, options.version, budgets);
  }

  app.get('/health/live', { schema: { response: { 200: LiveResponse } } }, async () => ({
    status: 'ok' as const,
  }));

  // Readiness runs every probe, so it is the one unauthenticated endpoint worth
  // hitting repeatedly. A budget of its own keeps that away from the database
  // while staying far above the rate any orchestrator polls at.
  app.get(
    '/health/ready',
    {
      schema: { response: { 200: ReadyResponse, 503: ReadyResponse } },
      ...(limited ? { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } } : {}),
    },
    async (request, reply) => {
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
      // The reason a probe failed can name a host, a user or a missing
      // migration. Readiness is unauthenticated, so an anonymous caller learns
      // only that it is degraded. `undefined` means no authentication is wired
      // at all, which is a development or test harness, and keeps the detail.
      if (request.humanAuth === null) {
        for (const check of Object.values(checks)) {
          if (check && 'error' in check) delete (check as { error?: string }).error;
        }
      }
      const body: ReadyResponse = {
        status: healthy ? 'ok' : 'degraded',
        version: options.version,
        checks,
      };
      reply.code(healthy ? 200 : 503);
      return body;
    },
  );

  /**
   * The single-page shell, with this response's nonce in it.
   *
   * Read once and kept: the bundle does not change while the process runs. What
   * does change is the nonce, which is why the shell cannot be served as a file
   * — and why it is `no-store` rather than `no-cache`. A stored body revalidated
   * with a 304 would carry yesterday's nonce under today's header, and the
   * styles the interface injects would be blocked again.
   */
  const shell = options.webDist
    ? await readFile(join(options.webDist, 'index.html'), 'utf8')
    : null;
  if (shell !== null && !shell.includes('</head>')) {
    // Refused at start-up rather than discovered later: with nowhere to put the
    // nonce, every dialog in the interface is blocked by our own policy, and
    // nothing about a running server would say why.
    throw new Error('the web bundle has no </head> to carry the style nonce');
  }
  const sendShell = (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const nonce = cspNonceOf(request);
    const html =
      shell === null || nonce === ''
        ? // No policy in this build, so nothing needs a nonce, and `content=""`
          // would only look like one that failed.
          (shell ?? '')
        : shell.replace('</head>', `  <meta name="csp-nonce" content="${nonce}" />\n  </head>`);
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
  };

  if (options.webDist) {
    await app.register(fastifyStatic, {
      root: options.webDist,
      prefix: '/',
      wildcard: false,
      // No `index`: the shell carries a per-response nonce and so cannot be
      // served from disk. `GET /` is a route of its own below.
      index: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // Hashed assets under /assets are immutable.
        const cache = filePath.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        void res.header('cache-control', cache);
      },
    });
    app.get('/', (request, reply) => sendShell(request, reply));
  }

  const webDist = options.webDist;
  // An unmatched path reaches no route, so no per-route budget ever applied to
  // it, and the single-page fallback reads index.html from disk on every hit.
  app.setNotFoundHandler(limited ? { preHandler: app.rateLimit() } : {}, (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const isApi = API_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
    if (webDist && request.method === 'GET' && !isApi) {
      return sendShell(request, reply);
    }
    return reply.code(404).send(NOT_FOUND);
  });

  await app.ready();
  return app;
}
