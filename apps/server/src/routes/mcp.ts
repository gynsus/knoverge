import { TOOLS } from '@knoverge/contracts';
import { DomainError } from '@knoverge/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { resolveWorkspaceActor } from '../plugins/actor-context.ts';
import type { CallMeta } from '../plugins/actor-decorators.ts';
import type { Services } from '../services.ts';
import { handlerFor } from './tools.ts';

/** The provenance fields of a call's `_meta`, ignoring everything else. */
function callMetaOf(meta: Record<string, unknown> | undefined): CallMeta | null {
  if (!meta) return null;
  const text = (key: string): string | undefined =>
    typeof meta[key] === 'string' ? (meta[key] as string) : undefined;
  return {
    session_id: text('session_id'),
    provider: text('provider'),
    model: text('model'),
    client: text('client'),
  };
}

/** What the server calls itself when a client asks. */
const SERVER_INFO = { name: 'knoverge', title: 'Knoverge' };

/**
 * A refusal an agent can act on.
 *
 * The same `ApiError` the HTTP transport answers with, carried as text
 * because MCP has no status codes: the code says what happened, `retryable`
 * says whether trying again could help, and the ids say what it happened to.
 * Output schemas are not applied to an error result, so the shape here is the
 * error shape rather than the tool's.
 */
function toolError(error: unknown): CallToolResult {
  const payload =
    error instanceof DomainError
      ? error.toApiError()
      : { code: 'INTERNAL_ERROR', message: 'an unexpected failure', retryable: true };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * One MCP server for one request.
 *
 * The tools close over the Fastify request, which is what carries the caller:
 * the bearer credential the agent authenticated with, the workspace header,
 * the idempotency key. Building the server per request is also why no session
 * is needed — there is no state between calls that the credential does not
 * already establish.
 */
function serverFor(services: Services, request: FastifyRequest, version: string): McpServer {
  const server = new McpServer({ ...SERVER_INFO, version });
  for (const tool of TOOLS) {
    const handler = handlerFor(tool.name);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: {
          title: tool.name,
          readOnlyHint: tool.readOnly,
          // Proposing the same thing twice makes two proposals, and approving
          // twice is refused rather than repeated, so nothing here is safe to
          // replay blindly. The idempotency key is how a caller retries.
          idempotentHint: false,
          // Nothing a tool does removes knowledge: a delete is logical and a
          // supersession keeps what it replaced.
          destructiveHint: false,
        },
      },
      (async (
        input: unknown,
        extra: { _meta?: Record<string, unknown> },
      ): Promise<CallToolResult> => {
        try {
          // What this call said about itself. Rule 3 wants the client, the
          // model and the session on every material write, and over MCP they
          // travel here rather than in headers.
          request.callMeta = callMetaOf(extra._meta);
          const output = await handler(services, request, input as never);
          return {
            structuredContent: output as Record<string, unknown>,
            // The same payload as text, for a client that shows tool results
            // to a person rather than parsing them.
            content: [{ type: 'text', text: JSON.stringify(output) }],
          };
        } catch (error) {
          return toolError(error);
        }
      }) as never,
    );
  }
  return server;
}

/**
 * The MCP endpoint, over Streamable HTTP (`ARCHITECTURE.md`, rule 11).
 *
 * The same tools as `POST /v1/<tool_name>`, from the same contract and
 * through the same handlers. An agent authenticates the way it does
 * everywhere else, with its bearer credential; there is no separate MCP
 * identity to keep in step.
 *
 * Stateless: no session id, no server-initiated stream. Every call carries
 * its own credential, so there is nothing for a session to remember, and a
 * deployment can run several containers without sticky routing.
 */
export function registerMcpRoutes(app: FastifyInstance, services: Services, version: string): void {
  app.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    // Before anything else: who is calling. Every tool resolves the actor
    // again when it runs, but a client with no credential would otherwise
    // connect, be handed the tool list, and be refused one call at a time
    // with no way to tell a bad token from a bad request.
    await resolveWorkspaceActor(services, request);
    const server = serverFor(services, request, version);
    // The SDK documents `sessionIdGenerator: undefined` as stateless mode,
    // and `exactOptionalPropertyTypes` refuses an explicitly undefined
    // optional property, so the options are built rather than declared. The
    // transport's own callbacks are optional in fact and required in its
    // `Transport` type, which is the same mismatch from the other side.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    // Fastify owns the response from here: the transport writes to the raw
    // socket, so the route must not also return a body.
    reply.hijack();
    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      // Per request, so the server and its transport go with it.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  // A client that opens the stream or ends a session is told plainly that
  // this endpoint keeps none, rather than being left waiting.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', { schema: { hide: true } }, async (_request, reply) =>
      reply.code(405).header('allow', 'POST').send({
        code: 'VALIDATION_ERROR',
        message:
          'this MCP endpoint is stateless: every call is a POST that carries its own credential',
        retryable: false,
      }),
    );
  }
}
