import {
  DeleteWebhookRequest,
  OkResponse,
  UpsertWebhookRequest,
  UpsertWebhookResponse,
  WebhooksResponse,
  type WebhookSummary,
} from '@knoverge/contracts';
import type { WebhookRecord } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

/**
 * Everything but the secret.
 *
 * It is sealed at rest and never served: an operator who lost it makes a new one,
 * which is the same answer an agent credential gives.
 */
function summary(webhook: WebhookRecord): WebhookSummary {
  return {
    id: webhook.id,
    workspace_id: webhook.workspaceId,
    url: webhook.url,
    event_types: webhook.eventTypes,
    status: webhook.status,
    cursor: webhook.cursor,
    failures: webhook.failures,
    last_delivery_at: webhook.lastDeliveryAt?.toISOString() ?? null,
    next_attempt_at: webhook.nextAttemptAt?.toISOString() ?? null,
    last_error: webhook.lastError,
    created_at: webhook.createdAt.toISOString(),
    updated_at: webhook.updatedAt.toISOString(),
  } as WebhookSummary;
}

/**
 * Administering where a workspace pushes notifications.
 *
 * `workspace.admin`, not `agent.manage`: a webhook is an outbound connection the
 * installation makes, and deciding where this server talks to is the workspace
 * owner's business rather than part of managing agents.
 */
export function registerAdminWebhookRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/webhooks.list',
    { schema: { response: { 200: WebhooksResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      const webhooks = await services.webhooks.list(actor.context.workspaceId);
      return {
        webhooks: webhooks.map(summary),
        secret_storage_configured: services.secretStorage,
      };
    },
  );

  r.post(
    '/v1/admin/webhooks.upsert',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpsertWebhookRequest, response: { 200: UpsertWebhookResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      const result = await services.webhooks.upsert(actor.context.workspaceId, {
        ...(request.body.webhook_id ? { webhookId: request.body.webhook_id } : {}),
        url: request.body.url,
        ...(request.body.secret ? { secret: request.body.secret } : {}),
        eventTypes: [...request.body.event_types],
        status: request.body.status,
      });
      return { webhook: summary(result.webhook), secret: result.secret };
    },
  );

  r.post(
    '/v1/admin/webhooks.delete',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: DeleteWebhookRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.webhooks.remove(actor.context.workspaceId, request.body.webhook_id);
      return { ok: true as const };
    },
  );
}
