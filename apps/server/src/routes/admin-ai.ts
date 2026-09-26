import {
  AiSettingsResponse,
  AssignAiModelRequest,
  CheckAiProviderRequest,
  CheckAiProviderResponse,
  RemoveAiProviderRequest,
  SaveAiProviderRequest,
  TestAiGenerationRequest,
  TestAiGenerationResponse,
  TestAiModelRequest,
  TestAiModelResponse,
  UnassignAiModelRequest,
  type AiProviderSummary,
  type AiSettings,
} from '@knoverge/contracts';
import type { AiProviderRecord, AiSettingsView } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function providerSummary(provider: AiProviderRecord): AiProviderSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    base_url: provider.baseUrl,
    origin: provider.origin,
    created_at: provider.createdAt.toISOString(),
    updated_at: provider.updatedAt.toISOString(),
    last_checked_at: provider.lastCheckedAt?.toISOString() ?? null,
    last_error: provider.lastError,
  };
}

function settings(view: AiSettingsView): AiSettings {
  return {
    providers: view.providers.map(providerSummary),
    assignments: view.assignments.map((assignment) => ({
      purpose: assignment.purpose,
      provider_id: assignment.providerId,
      model: assignment.model,
      updated_at: assignment.updatedAt.toISOString(),
    })),
    embeddings_enabled: view.embeddingsEnabled,
    generation_enabled: view.generationEnabled,
  };
}

/**
 * AI provider administration.
 *
 * Administration, not a tool: these are never offered to an agent and have no
 * MCP name to match (rule 11, ADR 0011). They require `workspace.admin`, which
 * no agent trust tier holds.
 *
 * The permission is the one workspace creation uses, and is the same widening:
 * there is no instance administrator, so whoever can administer a workspace can
 * administer this installation's AI. ADR 0021 records that as a gap.
 */
export function registerAdminAiRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/ai.settings',
    { schema: { response: { 200: AiSettingsResponse } } },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      return { ai: settings(await services.ai.settings()) };
    },
  );

  r.post(
    '/v1/admin/ai.providers.save',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: SaveAiProviderRequest, response: { 200: AiSettingsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      const saved = await services.ai.save({
        providerId: request.body.provider_id,
        kind: request.body.kind,
        name: request.body.name,
        baseUrl: request.body.base_url,
      });
      // Not a ledger event: the ledger is keyed by a per-workspace sequence
      // and a provider belongs to the installation. The log is where this is
      // recorded (ADR 0021).
      request.log.info(
        { providerId: saved.id, kind: saved.kind, actorId: actor.context.actorId },
        'an AI provider was configured',
      );
      return { ai: settings(await services.ai.settings()) };
    },
  );

  r.post(
    '/v1/admin/ai.providers.remove',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RemoveAiProviderRequest, response: { 200: AiSettingsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.ai.remove(request.body.provider_id);
      request.log.info(
        { providerId: request.body.provider_id, actorId: actor.context.actorId },
        'an AI provider was removed',
      );
      return { ai: settings(await services.ai.settings()) };
    },
  );

  r.post(
    '/v1/admin/ai.providers.check',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: CheckAiProviderRequest, response: { 200: CheckAiProviderResponse } },
    },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      // Answers rather than throws when the address is unreachable: being
      // unreachable is the finding, not a failure of the request.
      const outcome = await services.ai.check({
        kind: request.body.kind,
        baseUrl: request.body.base_url,
      });
      return outcome;
    },
  );

  r.post(
    '/v1/admin/ai.assign',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: AssignAiModelRequest, response: { 200: AiSettingsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.ai.assign({
        purpose: request.body.purpose,
        providerId: request.body.provider_id,
        model: request.body.model,
      });
      request.log.info(
        {
          purpose: request.body.purpose,
          model: request.body.model,
          actorId: actor.context.actorId,
        },
        'a model was put to work',
      );
      return { ai: settings(await services.ai.settings()) };
    },
  );

  r.post(
    '/v1/admin/ai.unassign',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UnassignAiModelRequest, response: { 200: AiSettingsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.ai.unassign(request.body.purpose);
      request.log.info(
        { purpose: request.body.purpose, actorId: actor.context.actorId },
        'a model was taken out of use',
      );
      return { ai: settings(await services.ai.settings()) };
    },
  );

  r.post(
    '/v1/admin/ai.test',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: TestAiModelRequest, response: { 200: TestAiModelResponse } },
    },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      const outcome = await services.ai.test({
        kind: request.body.kind,
        baseUrl: request.body.base_url,
        model: request.body.model,
        text: request.body.text,
      });
      return {
        ok: outcome.ok,
        dimensions: outcome.dimensions,
        latency_ms: outcome.latencyMs,
        error: outcome.error,
      };
    },
  );

  r.post(
    '/v1/admin/ai.test_generation',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: TestAiGenerationRequest, response: { 200: TestAiGenerationResponse } },
    },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      // A separate route rather than a flag on `ai.test`: the two answer
      // different things — one a dimension, one a sentence — and a response
      // whose shape depends on an input field is one a caller has to guess at.
      const outcome = await services.ai.testGeneration({
        kind: request.body.kind,
        baseUrl: request.body.base_url,
        model: request.body.model,
        text: request.body.text,
      });
      return {
        ok: outcome.ok,
        text: outcome.text,
        latency_ms: outcome.latencyMs,
        error: outcome.error,
      };
    },
  );
}
