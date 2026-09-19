import type { ApiError } from '@knoverge/contracts';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyReply {
    /** Set by the error handler so the completion line can carry the code. */
    knovergeErrorCode?: ApiError['code'];
  }
}

/**
 * One structured line per request with the fields ARCHITECTURE.md section 12
 * requires: request id, workspace, actor, agent, operation, duration and error
 * code. Fastify's own completion line carries neither the actor nor the code.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    const human = request.humanAuth;
    const agent = request.agentAuth;
    request.log.info(
      {
        operation: `${request.method} ${request.routeOptions.url ?? request.url}`,
        durationMs: Math.round(reply.elapsedTime),
        status: reply.statusCode,
        workspaceId: agent?.agent.workspaceId ?? null,
        actorId: agent?.agent.actorId ?? null,
        userId: human?.user.id ?? null,
        agentId: agent?.agent.id ?? null,
        errorCode: reply.knovergeErrorCode ?? null,
      },
      'request handled',
    );
  });
}
