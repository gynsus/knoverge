import fastifySwagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/**
 * OpenAPI document generated from the Zod contracts (HTTP_API.md section 10).
 * Must be registered before the routes it documents.
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
    },
    transform: jsonSchemaTransform,
  });
  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
}
