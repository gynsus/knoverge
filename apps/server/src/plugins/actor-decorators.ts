import type { FastifyInstance } from 'fastify';

/**
 * The provenance a tool call carries over MCP.
 *
 * `MCP_API.md` section 4: where the client supports it, a call names its
 * session, provider, model and client in `_meta`. Over HTTP the same things
 * arrive as headers.
 */
export interface CallMeta {
  session_id?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  client?: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the MCP endpoint for the tool it is running; null otherwise. */
    callMeta: CallMeta | null;
  }
}

/**
 * Declares the request properties the context plugins fill. Decorating once,
 * before any hook runs, keeps every request on the same hidden class.
 */
export function registerActorDecorators(app: FastifyInstance): void {
  app.decorateRequest('humanAuth', null);
  app.decorateRequest('agentAuth', null);
  // What a tool call carried in its MCP `_meta`, which over HTTP arrives in
  // headers instead. Null on every request the MCP endpoint did not make.
  app.decorateRequest('callMeta', null);
}
