import {
  DeletePolicyRuleRequest,
  GrantPermissionRequest,
  OkResponse,
  PermissionsQuery,
  PermissionsResponse,
  PolicyRuleResponse,
  PolicyRulesResponse,
  RevokePermissionRequest,
  UpsertPolicyRuleRequest,
  type PermissionGrantSummary,
  type PolicyRuleSummary,
} from '@knoverge/contracts';
import type { PermissionGrantRecord, PolicyRuleRecord } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function grantSummary(grant: PermissionGrantRecord): PermissionGrantSummary {
  return {
    id: grant.id,
    workspace_id: grant.workspaceId,
    actor_id: grant.actorId,
    action: grant.action,
    scope: grant.scope,
    effect: grant.effect,
    created_at: grant.createdAt.toISOString(),
  };
}

function ruleSummary(rule: PolicyRuleRecord): PolicyRuleSummary {
  return {
    id: rule.id,
    workspace_id: rule.workspaceId,
    priority: rule.priority,
    subject: rule.subject,
    action: rule.action,
    scope: rule.scope,
    effect: rule.effect,
    enabled: rule.enabled,
    created_at: rule.createdAt.toISOString(),
  };
}

/** Permission grants and policy rules. Requires the policy.manage permission. */
export function registerAdminPolicyRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/permissions.list',
    { schema: { querystring: PermissionsQuery, response: { 200: PermissionsResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'policy.manage');
      const grants = await services.authorizationAdmin.listGrants(
        actor.context,
        request.query.actor_id,
      );
      return { grants: grants.map(grantSummary) };
    },
  );

  r.post(
    '/v1/admin/permissions.grant',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: GrantPermissionRequest, response: { 200: PermissionsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'policy.manage');
      await services.authorizationAdmin.grant(actor.context, {
        actorId: request.body.actor_id,
        action: request.body.action,
        effect: request.body.effect,
        scope: request.body.scope,
      });
      const grants = await services.authorizationAdmin.listGrants(
        actor.context,
        request.body.actor_id,
      );
      return { grants: grants.map(grantSummary) };
    },
  );

  r.post(
    '/v1/admin/permissions.revoke',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RevokePermissionRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'policy.manage');
      await services.authorizationAdmin.revokeGrant(actor.context, request.body.grant_id);
      return { ok: true as const };
    },
  );

  r.get(
    '/v1/admin/policy.rules',
    { schema: { response: { 200: PolicyRulesResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'policy.manage');
      const rules = await services.authorizationAdmin.listRules(actor.context);
      return { rules: rules.map(ruleSummary) };
    },
  );

  r.post(
    '/v1/admin/policy.rules.upsert',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpsertPolicyRuleRequest, response: { 200: PolicyRuleResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'policy.manage');
      const body = request.body;
      const rule = await services.authorizationAdmin.upsertRule(actor.context, {
        ruleId: body.rule_id,
        priority: body.priority,
        subject: body.subject,
        action: body.action,
        scope: body.scope,
        effect: body.effect,
        enabled: body.enabled,
      });
      return { rule: ruleSummary(rule) };
    },
  );

  r.post(
    '/v1/admin/policy.rules.delete',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: DeletePolicyRuleRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'policy.manage');
      await services.authorizationAdmin.deleteRule(actor.context, request.body.rule_id);
      return { ok: true as const };
    },
  );
}
