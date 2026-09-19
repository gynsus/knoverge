import { ApiError } from '@knoverge/contracts';
import fastifySwagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * OpenAPI document generated from the Zod contracts (HTTP_API.md section 10).
 * Must be registered before the routes it documents.
 *
 * The document describes failure as well as success. A generated client built
 * from a document with only 200 responses cannot handle a refusal, a conflict
 * or a rate limit, and one with no security scheme cannot authenticate at all.
 */
export async function registerOpenApi(app: FastifyInstance, version: string): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Knoverge HTTP API',
        description: 'The same contract as the MCP tools, exposed over HTTP.',
        version,
      },
      components: {
        securitySchemes: {
          // A person signs in and carries a cookie; an agent carries a token.
          session: { type: 'apiKey', in: 'cookie', name: 'knoverge_session' },
          agentToken: { type: 'http', scheme: 'bearer', bearerFormat: 'knv_<prefix>_<secret>' },
        },
      },
      security: [{ session: [] }, { agentToken: [] }],
    },
    transform: jsonSchemaTransform,
  });
  // Added to the finished document rather than to each route's schema: the
  // generator turns a route schema into JSON Schema, and these apply to every
  // operation equally, so describing them once here keeps the routes readable.
  app.get('/v1/openapi.json', { schema: { hide: true } }, async () =>
    describeFailure(app.swagger()),
  );
}

/** Headers every route accepts, which the schemas themselves cannot describe. */
const SHARED_HEADERS = [
  {
    in: 'header',
    name: 'X-Knoverge-Workspace',
    required: false,
    description:
      "Which workspace the request applies to. Required for a person who belongs to more than one; ignored for an agent, which is bound to its credential's workspace.",
    schema: { type: 'string' },
  },
  {
    in: 'header',
    name: 'Idempotency-Key',
    required: false,
    description:
      'Makes a mutation safe to retry. The same key with the same body returns the first result; with a different body it is refused.',
    schema: { type: 'string' },
  },
  {
    in: 'header',
    name: 'X-Request-Id',
    required: false,
    description: 'Groups a call with its retries in the ledger. Generated when absent.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
  },
];

/**
 * Every route can answer with the shared error shape. The codes are listed in
 * docs/HTTP_API.md; these are the statuses they map to.
 */
const ERROR_DESCRIPTIONS: Record<string, string> = {
  '400': 'The request was refused: validation, conflict or policy.',
  '401': 'Not signed in, or the credential is unusable.',
  '403': 'Signed in, but not permitted.',
  '404': 'No such object, or none the caller may see.',
  '409': 'The object changed since it was read.',
  '429': 'Too many requests. Retry after the time in Retry-After.',
  '500': 'An unexpected failure. The detail is logged, never sent.',
};

interface OpenApiDocument {
  components?: { schemas?: Record<string, unknown> };
  paths?: Record<string, Record<string, Record<string, unknown>>>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Adds the shared errors and headers to every operation in the document. */
function describeFailure(document: unknown): unknown {
  const doc = document as OpenApiDocument;
  const components = (doc.components ??= {});
  const schemas = (components.schemas ??= {});
  schemas['ApiError'] = z.toJSONSchema(ApiError, { io: 'output' });
  const errorRef = { $ref: '#/components/schemas/ApiError' };

  for (const operations of Object.values(doc.paths ?? {})) {
    for (const method of METHODS) {
      const operation = operations[method];
      if (!operation) continue;
      const responses = (operation['responses'] ??= {}) as Record<string, unknown>;
      for (const [status, description] of Object.entries(ERROR_DESCRIPTIONS)) {
        responses[status] ??= {
          description,
          content: { 'application/json': { schema: errorRef } },
        };
      }
      const parameters = (operation['parameters'] ??= []) as unknown[];
      parameters.push(...SHARED_HEADERS);
    }
  }
  return doc;
}
