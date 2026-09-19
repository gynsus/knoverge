import {
  AddMemberRequest,
  MembersResponse,
  OkResponse,
  RemoveMemberRequest,
  UpdateMemberRequest,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
  type MemberSummary,
} from '@knoverge/contracts';
import type { MemberWithUser } from '@knoverge/core';
import { DomainError } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission, resolveWorkspaceActor } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function memberSummary(member: MemberWithUser): MemberSummary {
  return {
    user_id: member.userId,
    actor_id: member.actorId,
    email: member.email,
    display_name: member.displayName,
    role: member.role,
    status: member.status,
    joined_at: member.createdAt.toISOString(),
    last_login_at: member.lastLoginAt?.toISOString() ?? null,
  };
}

/** Workspace settings and membership. Requires workspace.admin. */
export function registerAdminWorkspaceRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/workspace.get',
    { schema: { response: { 200: WorkspaceResponse } } },
    async (request) => {
      const actor = await resolveWorkspaceActor(services, request);
      const workspace = await services.repositories.workspaces.findById(actor.context.workspaceId);
      if (!workspace) throw new DomainError('NOT_FOUND', 'workspace not found');
      return {
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          description: workspace.description,
          default_language: workspace.defaultLanguage,
          created_at: workspace.createdAt.toISOString(),
          role: actor.role ?? 'viewer',
        },
      };
    },
  );

  r.post(
    '/v1/admin/workspace.update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpdateWorkspaceRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.members.updateWorkspace(actor.context, {
        name: request.body.name,
        description: request.body.description,
        defaultLanguage: request.body.default_language,
      });
      return { ok: true as const };
    },
  );

  r.get(
    '/v1/admin/members.list',
    { schema: { response: { 200: MembersResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      const members = await services.members.list(actor.context.workspaceId);
      return { members: members.map(memberSummary) };
    },
  );

  r.post(
    '/v1/admin/members.add',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: AddMemberRequest, response: { 200: MembersResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.members.add(actor.context, {
        email: request.body.email,
        role: request.body.role,
        displayName: request.body.display_name,
        initialPassword: request.body.initial_password,
      });
      const members = await services.members.list(actor.context.workspaceId);
      return { members: members.map(memberSummary) };
    },
  );

  r.post(
    '/v1/admin/members.update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpdateMemberRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.members.updateRole(actor.context, request.body.user_id, request.body.role);
      return { ok: true as const };
    },
  );

  r.post(
    '/v1/admin/members.remove',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RemoveMemberRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.members.remove(actor.context, request.body.user_id);
      return { ok: true as const };
    },
  );
}
