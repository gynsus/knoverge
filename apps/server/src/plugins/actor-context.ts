import type { ActorContext, ActorStanding } from '@knoverge/core';
import { DomainError } from '@knoverge/core';
import type { PermissionAction } from '@knoverge/contracts';
import type { Target } from '@knoverge/policy';
import type { MembershipRole, WorkspaceId } from '@knoverge/contracts';
import { WorkspaceId as WorkspaceIdSchema } from '@knoverge/contracts';
import type { FastifyRequest } from 'fastify';

import type { Services } from '../services.ts';

export const WORKSPACE_HEADER = 'x-knoverge-workspace';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Reads the idempotency key from its header or from the body field of the same name. */
export function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers[IDEMPOTENCY_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader !== undefined) return fromHeader;
  const body = request.body;
  if (body && typeof body === 'object' && 'idempotency_key' in body) {
    const value = (body as { idempotency_key?: unknown }).idempotency_key;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Optional provenance headers are telemetry, not authority. They are trimmed to
 * printable ASCII and to the width of their ledger column, so a long or odd
 * header cannot fail a write or smuggle anything into an event.
 */
const PROVENANCE_LIMITS = { client: 64, provider: 64, model: 128 } as const;

function sanitise(value: string | string[] | undefined, max: number): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const cleaned = raw
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

function contextMeta(
  request: FastifyRequest,
): Omit<ActorContext, 'workspaceId' | 'actorId' | 'actorType'> {
  // A tool call over MCP carries its provenance in `_meta`; the same call over
  // HTTP carries it in headers. Rule 3 wants it either way, so both are read
  // here and the transport is not something the domain has to know about.
  const meta = request.callMeta;
  const pick = (from: string | undefined, header: string, limit: number) =>
    sanitise(from, limit) ?? sanitise(request.headers[header], limit);
  const client = pick(meta?.client, 'x-knoverge-client', PROVENANCE_LIMITS.client);
  const provider = pick(meta?.provider, 'x-knoverge-provider', PROVENANCE_LIMITS.provider);
  const model = pick(meta?.model, 'x-knoverge-model', PROVENANCE_LIMITS.model);
  return {
    requestId: request.id,
    ...(client ? { client } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
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
        // An agent's session is the client's own conversation id, when it
        // sends one. It is namespaced because the caller chooses it: without
        // the prefix an agent could stamp its events with a person's session id
        // and have the audit trail read as if that person had acted.
        ...(sanitise(request.callMeta?.session_id ?? request.headers['x-knoverge-session-id'], 124)
          ? {
              sessionId: `ext:${
                sanitise(
                  request.callMeta?.session_id ?? request.headers['x-knoverge-session-id'],
                  124,
                ) as string
              }`,
            }
          : {}),
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
      // The real session, never a header: a caller must not choose its own attribution.
      sessionId: human.session.id,
      ...meta,
    },
    role: membership.role,
    standing: { role: membership.role },
  };
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

/**
 * For endpoints that list things: the caller must hold the action somewhere,
 * and the results are filtered to what their scopes cover. Checking one empty
 * target instead would refuse anyone whose grant covers a single branch.
 */
export async function requireListPermission(
  services: Services,
  request: FastifyRequest,
  action: PermissionAction,
): Promise<WorkspaceActor> {
  const actor = await resolveWorkspaceActor(services, request);
  if (!(await services.authorization.mayList(actor.context, actor.standing, action))) {
    await services.authorization.recordDenied(actor.context, action, 'no_grant');
    throw new DomainError('FORBIDDEN', `not permitted: ${action}`);
  }
  return actor;
}
