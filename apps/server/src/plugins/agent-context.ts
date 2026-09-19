import type { ResolvedCredential } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';

import type { Services } from '../services.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved from a bearer credential; null when the caller is not an agent. */
    agentAuth: ResolvedCredential | null;
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Resolves the Authorization header on API requests. Failures are silent: the
 * route decides whether an unauthenticated caller is acceptable, and the
 * response never distinguishes unknown, revoked, expired or disabled tokens.
 */
export function registerAgentContext(app: FastifyInstance, services: Services): void {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/') && !request.url.startsWith('/mcp')) return;
    const header = request.headers.authorization;
    const match = header ? BEARER.exec(header) : null;
    if (!match?.[1]) return;
    request.agentAuth = await services.agents.authenticate(match[1]);
  });
}
