import { createHash } from 'node:crypto';

import {
  AddMemberRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  ActorsResponse,
  WorkspacesResponse,
  type ActorId,
  type WorkspaceId,
  MembersResponse,
  OkResponse,
  RemoveMemberRequest,
  ResetMemberPasswordRequest,
  UpdateMemberRequest,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
  type MemberSummary,
} from '@knoverge/contracts';
import type { MemberWithUser, UserRecord } from '@knoverge/core';
import { DomainError } from '@knoverge/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  idempotencyKey,
  requirePermission,
  resolveWorkspaceActor,
} from '../plugins/actor-context.ts';
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

/**
 * The person behind a workspace-creating request, and the membership that
 * authorises it: one where they hold `workspace.admin`.
 *
 * The permission is asked of the authorisation service rather than read off
 * the role, so somebody granted workspace administration explicitly is treated
 * the same as an owner — the same rule the rest of the interface follows.
 */
async function resolveCreator(
  services: Services,
  request: FastifyRequest,
): Promise<{ user: UserRecord; actorId: ActorId; workspaceId: WorkspaceId }> {
  const human = request.humanAuth;
  // An agent has a workspace of its own and no standing outside it. Creating
  // one is a person's act.
  if (!human) throw new DomainError('UNAUTHENTICATED', 'sign in required');

  const memberships = await services.repositories.memberships.listForUser(human.user.id);
  for (const membership of memberships) {
    const context = {
      workspaceId: membership.workspaceId,
      actorId: membership.actorId,
      actorType: 'human' as const,
      sessionId: human.session.id,
      requestId: request.id,
    };
    const held = await services.authorization.heldActions(context, { role: membership.role });
    if (held.includes('workspace.admin')) {
      return {
        user: human.user,
        actorId: membership.actorId,
        workspaceId: membership.workspaceId,
      };
    }
  }
  // Recorded where it can be seen: the first workspace this person belongs to.
  // A refusal with nowhere to record it is still a refusal.
  const first = memberships[0];
  if (first) {
    await services.authorization.recordDenied(
      {
        workspaceId: first.workspaceId,
        actorId: first.actorId,
        actorType: 'human',
        sessionId: human.session.id,
        requestId: request.id,
      },
      'workspace.admin',
      'no_grant',
    );
  }
  throw new DomainError('FORBIDDEN', 'creating a workspace requires administering an existing one');
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
          // Null for an agent, which has a trust tier and no role. Reporting
          // 'viewer' invented a membership the caller does not have.
          role: actor.role ?? null,
        },
        permissions: await services.authorization.heldActions(actor.context, actor.standing),
      };
    },
  );

  /**
   * Who has acted in this workspace, by id.
   *
   * Events and a category's provenance record an actor id and nothing else, so
   * without this every history line and every "created by" reads as
   * `act_01J8Z…`. Any member may read it: the names are already attached to
   * the events those members can read, and the lists this does not touch —
   * members with their addresses, agents with their tiers and credentials —
   * stay behind workspace.admin and agent.manage.
   */
  r.get('/v1/actors.list', { schema: { response: { 200: ActorsResponse } } }, async (request) => {
    const actor = await resolveWorkspaceActor(services, request);
    const actors = await services.repositories.actors.listForWorkspace(actor.context.workspaceId);
    return {
      actors: actors.map((a) => ({
        id: a.id,
        type: a.type,
        display_name: a.displayName,
        agent_id: a.agentId,
        disabled: a.disabledAt !== null,
      })),
    };
  });

  /**
   * The workspaces this person belongs to.
   *
   * Not scoped to the current workspace — it is the list you choose one from,
   * so scoping it to a choice already made would be circular. A person sees
   * their own memberships and nothing else, which is why it needs no
   * permission beyond a session: membership is the permission.
   */
  r.get(
    '/v1/workspaces.list',
    { schema: { response: { 200: WorkspacesResponse } } },
    async (request) => {
      const human = request.humanAuth;
      // An agent is bound to one workspace and has no view across them.
      if (!human) throw new DomainError('UNAUTHENTICATED', 'sign in required');

      const memberships = await services.repositories.memberships.listForUser(human.user.id);
      const stats = await services.repositories.workspaces.statsFor(
        memberships.map((m) => m.workspaceId),
      );
      const records = await Promise.all(
        memberships.map((m) => services.repositories.workspaces.findById(m.workspaceId)),
      );
      // Asked of the authorisation service per workspace rather than read off
      // the role: a grant can widen or narrow what a role confers, and an
      // interface that guesses from the role drifts from the server that
      // decides.
      const held = await Promise.all(
        memberships.map((m) =>
          services.authorization.heldActions(
            {
              workspaceId: m.workspaceId,
              actorId: m.actorId,
              actorType: 'human',
              sessionId: human.session.id,
              requestId: request.id,
            },
            { role: m.role },
          ),
        ),
      );
      return {
        workspaces: memberships.flatMap((membership, index) => {
          const workspace = records[index];
          if (!workspace) return [];
          const counts = stats.get(membership.workspaceId);
          return [
            {
              id: workspace.id,
              slug: workspace.slug,
              name: workspace.name,
              description: workspace.description,
              default_language: workspace.defaultLanguage,
              created_at: workspace.createdAt.toISOString(),
              role: membership.role,
              item_count: counts?.items ?? 0,
              agent_count: counts?.agents ?? 0,
              last_activity_at: counts?.lastActivityAt?.toISOString() ?? null,
              permissions: held[index] ?? [],
            },
          ];
        }),
      };
    },
  );

  /**
   * Creates a workspace, with the caller as its owner.
   *
   * Not scoped to the current workspace, so it cannot go through
   * `requirePermission`: there is no workspace yet to hold a permission in.
   * The rule instead is that the caller must already administer one. Creating
   * a workspace makes you its owner, and an owner can create accounts on the
   * installation through `members.add` — accounts are global, not scoped to a
   * workspace. Letting a viewer create a workspace would therefore let a
   * viewer create users, which is the thing administration is for.
   *
   * An agent never reaches this: it requires a person's session.
   */
  r.post(
    '/v1/admin/workspace.create',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: CreateWorkspaceRequest, response: { 200: CreateWorkspaceResponse } },
    },
    async (request) => {
      const creator = await resolveCreator(services, request);
      const workspace = await services.members.createWorkspace(
        creator.user,
        {
          slug: request.body.slug,
          name: request.body.name,
          requestId: request.id,
          ...(request.body.description !== undefined
            ? { description: request.body.description }
            : {}),
          ...(request.body.default_language !== undefined
            ? { defaultLanguage: request.body.default_language }
            : {}),
        },
        { actorId: creator.actorId, workspaceId: creator.workspaceId },
      );
      return {
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          description: workspace.description,
          default_language: workspace.defaultLanguage,
          created_at: workspace.createdAt.toISOString(),
          role: 'owner' as const,
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
      const result = await services.idempotency.run(
        actor.context,
        idempotencyKey(request),
        'members.add',
        // The password is part of the request but never of the stored
        // response, so only its digest goes into the fingerprint. Dropping it
        // would make a retry that corrects the password return the first
        // result, leaving the administrator with a password that is not live.
        {
          ...request.body,
          initial_password: request.body.initial_password
            ? createHash('sha256').update(request.body.initial_password).digest('hex')
            : undefined,
        },
        async () => {
          await services.members.add(actor.context, actor.standing, {
            email: request.body.email,
            role: request.body.role,
            displayName: request.body.display_name,
            initialPassword: request.body.initial_password,
          });
          const members = await services.members.list(actor.context.workspaceId);
          return { members: members.map(memberSummary) };
        },
      );
      return result.value;
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
      await services.members.updateRole(
        actor.context,
        actor.standing,
        request.body.user_id,
        request.body.role,
      );
      return { ok: true as const };
    },
  );

  r.post(
    '/v1/admin/members.reset_password',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: ResetMemberPasswordRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      await services.members.resetPassword(
        actor.context,
        actor.standing,
        request.body.user_id,
        request.body.new_password,
      );
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
      await services.members.remove(actor.context, actor.standing, request.body.user_id);
      return { ok: true as const };
    },
  );
}
