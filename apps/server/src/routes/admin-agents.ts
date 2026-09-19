import {
  AgentResponse,
  AgentsResponse,
  CreateAgentRequest,
  CredentialsResponse,
  IssueCredentialRequest,
  IssueCredentialResponse,
  ListCredentialsQuery,
  OkResponse,
  RevokeCredentialRequest,
  UpdateAgentRequest,
  type AgentSummary,
  type CredentialSummary,
} from '@knoverge/contracts';
import type { AgentRecord, CredentialRecord } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { idempotencyKey, requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function credentialSummary(credential: CredentialRecord): CredentialSummary {
  return {
    id: credential.id,
    agent_id: credential.agentId,
    token_prefix: credential.tokenPrefix,
    label: credential.label,
    created_at: credential.createdAt.toISOString(),
    expires_at: credential.expiresAt?.toISOString() ?? null,
    revoked_at: credential.revokedAt?.toISOString() ?? null,
    last_used_at: credential.lastUsedAt?.toISOString() ?? null,
  };
}

async function agentSummary(services: Services, agent: AgentRecord): Promise<AgentSummary> {
  return {
    id: agent.id,
    workspace_id: agent.workspaceId,
    actor_id: agent.actorId,
    name: agent.name,
    description: agent.description,
    client_type: agent.clientType,
    trust_tier: agent.trustTier,
    status: agent.status,
    created_at: agent.createdAt.toISOString(),
    last_seen_at: agent.lastSeenAt?.toISOString() ?? null,
    active_credentials: await services.agents.countActiveCredentials(agent.id),
  };
}

/**
 * Agent administration. Requires agent.manage, which no agent trust tier holds.
 */
export function registerAdminAgentRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/agents.list',
    { schema: { response: { 200: AgentsResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const agents = await services.agents.list(actor.context.workspaceId);
      return { agents: await Promise.all(agents.map((a) => agentSummary(services, a))) };
    },
  );

  r.post(
    '/v1/admin/agents.create',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: CreateAgentRequest, response: { 200: AgentResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const result = await services.idempotency.run(
        actor.context,
        idempotencyKey(request),
        request.body,
        async () => {
          const agent = await services.agents.create(actor.context, {
            name: request.body.name,
            description: request.body.description,
            clientType: request.body.client_type,
            trustTier: request.body.trust_tier,
          });
          return { agent: await agentSummary(services, agent) };
        },
      );
      return result.value;
    },
  );

  r.post(
    '/v1/admin/agents.update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpdateAgentRequest, response: { 200: AgentResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const body = request.body;
      const agent = await services.agents.update(actor.context, {
        agentId: body.agent_id,
        name: body.name,
        description: body.description,
        clientType: body.client_type,
        trustTier: body.trust_tier,
        status: body.status,
      });
      return { agent: await agentSummary(services, agent) };
    },
  );

  r.get(
    '/v1/admin/agents.credentials',
    {
      schema: { querystring: ListCredentialsQuery, response: { 200: CredentialsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const credentials = await services.agents.listCredentials(
        actor.context.workspaceId,
        request.query.agent_id,
      );
      return { credentials: credentials.map(credentialSummary) };
    },
  );

  r.post(
    '/v1/admin/agents.credentials.issue',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: IssueCredentialRequest, response: { 200: IssueCredentialResponse } },
    },
    // Deliberately not idempotent: the response carries the token once, and
    // storing it to replay would mean keeping a live credential in the clear.
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const issued = await services.agents.issueCredential(actor.context, {
        agentId: request.body.agent_id,
        label: request.body.label,
        expiresInDays: request.body.expires_in_days,
      });
      return { credential: credentialSummary(issued.credential), token: issued.token };
    },
  );

  r.post(
    '/v1/admin/agents.credentials.revoke',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RevokeCredentialRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      await services.agents.revokeCredential(actor.context, request.body.credential_id);
      return { ok: true as const };
    },
  );
}
