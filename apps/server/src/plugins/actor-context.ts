import type { ActorContext, ActorStanding } from '@knoverge/core';
import { DomainError } from '@knoverge/core';
import type { PermissionAction } from '@knoverge/contracts';
import type { Target } from '@knoverge/policy';
import type { MembershipRole, WorkspaceId } from '@knoverge/contracts';
import { WorkspaceId as WorkspaceIdSchema } from '@knoverge/contracts';
import type { FastifyRequest } from 'fastify';

import type { Services } from '../services.ts';

export const WORKSPACE_HEADER = 'x-knoverge-workspace';

const ROLE_RANK: Record<MembershipRole, number> = { viewer: 0, reviewer: 1, admin: 2, owner: 3 };

function contextMeta(request: FastifyRequest) {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    requestId: request.id,
    ...(header('x-knoverge-session-id')
      ? { sessionId: header('x-knoverge-session-id') as string }
      : {}),
    ...(header('x-knoverge-client') ? { client: header('x-knoverge-client') as string } : {}),
    ...(header('x-knoverge-provider') ? { provider: header('x-knoverge-provider') as string } : {}),
    ...(header('x-knoverge-model') ? { model: header('x-knoverge-model') as string } : {}),
  };
}

export interface WorkspaceActor {
  context: ActorContext;
  /** Present for human callers; agents have no membership role. */
  role: MembershipRole | undefined;
  /** What the caller holds before explicit grants: a role or a trust tier. */
  standing: ActorStanding;
}

/**
 * Resolves the actor for a workspace-scoped request. Agents are bound to their
 * own workspace; humans select one with the X-Knoverge-Workspace header, or
 * implicitly when they belong to exactly one.
 */
export async function resolveWorkspaceActor(
  services: Services,
  request: FastifyRequest,
): Promise<WorkspaceActor> {
  const meta = contextMeta(request);

  if (request.agentAuth) {
    const { agent } = request.agentAuth;
    return {
      context: {
        workspaceId: agent.workspaceId,
        actorId: agent.actorId,
        actorType: 'agent',
        agentId: agent.id,
        ...meta,
      },
      role: undefined,
      standing: { trustTier: agent.trustTier },
    };
  }

  const human = request.humanAuth;
  if (!human) throw new DomainError('UNAUTHENTICATED', 'sign in required');

  const memberships = await services.repositories.memberships.listForUser(human.user.id);
  if (memberships.length === 0) {
    throw new DomainError('FORBIDDEN', 'you are not a member of any workspace');
  }
  const requested = request.headers[WORKSPACE_HEADER];
  const wanted = Array.isArray(requested) ? requested[0] : requested;
  let selected = memberships[0];
  if (wanted !== undefined) {
    const parsed = WorkspaceIdSchema.safeParse(wanted);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'invalid workspace id');
    const found = memberships.find((m) => m.workspaceId === (parsed.data as WorkspaceId));
    if (!found) throw new DomainError('FORBIDDEN', 'you are not a member of this workspace');
    selected = found;
  } else if (memberships.length > 1) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `select a workspace with the ${WORKSPACE_HEADER} header`,
    );
  }
  const membership = selected!;
  return {
    context: {
      workspaceId: membership.workspaceId,
      actorId: membership.actorId,
      actorType: 'human',
      ...meta,
    },
    role: membership.role,
    standing: { role: membership.role },
  };
}

/** Requires a human caller with at least the given workspace role. */
export async function requireRole(
  services: Services,
  request: FastifyRequest,
  minimum: MembershipRole,
): Promise<WorkspaceActor> {
  const actor = await resolveWorkspaceActor(services, request);
  if (actor.role === undefined || ROLE_RANK[actor.role] < ROLE_RANK[minimum]) {
    throw new DomainError('FORBIDDEN', `this action requires the ${minimum} role`);
  }
  return actor;
}

/**
 * Resolves the actor and refuses the request unless the permission applies.
 * A refusal is recorded as a command.denied event by the authorization service.
 */
export async function requirePermission(
  services: Services,
  request: FastifyRequest,
  action: PermissionAction,
  target: Target = {},
): Promise<WorkspaceActor> {
  const actor = await resolveWorkspaceActor(services, request);
  await services.authorization.require(actor.context, actor.standing, action, target);
  return actor;
}
