import type { FastifyInstance } from 'fastify';

/**
 * Declares the request properties the context plugins fill. Decorating once,
 * before any hook runs, keeps every request on the same hidden class.
 */
export function registerActorDecorators(app: FastifyInstance): void {
  app.decorateRequest('humanAuth', null);
  app.decorateRequest('agentAuth', null);
}
