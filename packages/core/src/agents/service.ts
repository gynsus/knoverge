import {
  type ActorId,
  AgentName,
  type AgentId,
  type AgentStatus,
  ClientType,
  type TrustTier,
  type WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { TokenService } from '../identity/ports.ts';
import type { ActorRepository } from '../workspace/repository.ts';
import type {
  AgentPatch,
  AgentRecord,
  AgentRepository,
  CredentialRecord,
  CredentialRepository,
  ResolvedCredential,
} from './repository.ts';

export const TOKEN_PREFIX = 'knv';

export interface AgentServiceOptions {
  uow: UnitOfWork;
  agents: AgentRepository;
  credentials: CredentialRepository;
  actors: ActorRepository;
  ledger: EventLedger;
  tokens: TokenService;
  clock?: Clock;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  clientType?: string | undefined;
  trustTier?: TrustTier | undefined;
}

export interface UpdateAgentInput {
  agentId: AgentId;
  name?: string | undefined;
  description?: string | null | undefined;
  clientType?: string | null | undefined;
  trustTier?: TrustTier | undefined;
  status?: AgentStatus | undefined;
}

export interface IssueCredentialInput {
  agentId: AgentId;
  label?: string | undefined;
  expiresInDays?: number | undefined;
}

export interface IssuedCredential {
  credential: CredentialRecord;
  /** Returned once; only the hash is stored. */
  token: string;
}

/**
 * Agent identities and their bearer credentials. Every mutation is recorded in
 * the ledger; the token itself never appears in an event.
 */
export class AgentService {
  private readonly o: AgentServiceOptions;
  private readonly clock: Clock;

  constructor(options: AgentServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async create(actor: ActorContext, input: CreateAgentInput): Promise<AgentRecord> {
    const name = AgentName.safeParse(input.name);
    if (!name.success) throw new DomainError('VALIDATION_ERROR', 'agent name is required');
    if (input.clientType !== undefined && !ClientType.safeParse(input.clientType).success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid client type');
    }
    if (await this.o.agents.findByName(actor.workspaceId, name.data)) {
      throw new DomainError('VALIDATION_ERROR', `an agent named "${name.data}" already exists`);
    }
    const now = this.clock.now();
    const actorId = newId('act') as ActorId;
    const agent: AgentRecord = {
      id: newId('ag') as AgentId,
      workspaceId: actor.workspaceId,
      actorId,
      name: name.data,
      description: input.description?.trim() || null,
      clientType: input.clientType?.trim() || null,
      trustTier: input.trustTier ?? 'propose',
      status: 'active',
      createdByActorId: actor.actorId,
      createdAt: now,
      lastSeenAt: null,
      metadata: {},
    };
    await this.o.uow.run(async (tx) => {
      await this.o.actors.insert(tx, {
        id: actorId,
        workspaceId: actor.workspaceId,
        type: 'agent',
        displayName: agent.name,
        userId: null,
        agentId: agent.id,
        createdAt: now,
        disabledAt: null,
      });
      await this.o.agents.insert(tx, agent);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'agent.created',
        objectType: 'agent',
        objectId: agent.id,
        metadata: {
          actor_id: actorId,
          trust_tier: agent.trustTier,
          ...(agent.clientType ? { client_type: agent.clientType } : {}),
        },
      });
    });
    return agent;
  }

  async update(actor: ActorContext, input: UpdateAgentInput): Promise<AgentRecord> {
    const agent = await this.require(actor.workspaceId, input.agentId);
    const patch: AgentPatch = {};
    if (input.name !== undefined) {
      const name = AgentName.safeParse(input.name);
      if (!name.success) throw new DomainError('VALIDATION_ERROR', 'agent name is required');
      const clash = await this.o.agents.findByName(actor.workspaceId, name.data);
      if (clash && clash.id !== agent.id) {
        throw new DomainError('VALIDATION_ERROR', `an agent named "${name.data}" already exists`);
      }
      patch.name = name.data;
    }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.clientType !== undefined) patch.clientType = input.clientType?.trim() || null;
    if (input.trustTier !== undefined) patch.trustTier = input.trustTier;
    if (input.status !== undefined) patch.status = input.status;
    if (Object.keys(patch).length === 0) return agent;

    const now = this.clock.now();
    await this.o.uow.run(async (tx) => {
      await this.o.agents.update(tx, agent.id, patch);
      // Disabling an agent takes its credentials out of service immediately.
      const revoked =
        patch.status === 'disabled'
          ? await this.o.credentials.revokeAllForAgent(tx, agent.id, now)
          : 0;
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'agent.updated',
        objectType: 'agent',
        objectId: agent.id,
        metadata: {
          changed: Object.keys(patch).sort(),
          ...(revoked ? { revoked_credentials: revoked } : {}),
        },
      });
    });
    return { ...agent, ...patch };
  }

  list(workspaceId: WorkspaceId): Promise<AgentRecord[]> {
    return this.o.agents.list(workspaceId);
  }

  get(workspaceId: WorkspaceId, agentId: AgentId): Promise<AgentRecord | null> {
    return this.o.agents.findById(workspaceId, agentId);
  }

  countActiveCredentials(agentId: AgentId): Promise<number> {
    return this.o.credentials.countActive(agentId, this.clock.now());
  }

  listCredentials(workspaceId: WorkspaceId, agentId: AgentId): Promise<CredentialRecord[]> {
    return this.require(workspaceId, agentId).then((agent) =>
      this.o.credentials.listForAgent(agent.id),
    );
  }

  /**
   * Issues a bearer token. The value is returned once and never stored; the
   * event records only the credential id, prefix and expiry.
   */
  async issueCredential(
    actor: ActorContext,
    input: IssueCredentialInput,
  ): Promise<IssuedCredential> {
    const agent = await this.require(actor.workspaceId, input.agentId);
    if (agent.status !== 'active') {
      throw new DomainError('VALIDATION_ERROR', 'cannot issue a credential for a disabled agent');
    }
    const now = this.clock.now();
    const secret = this.o.tokens.generate();
    const id = newId('cred');
    // Identifies the credential in the token and in logs without revealing the secret.
    const tokenPrefix = (id.split('_')[1] ?? id).slice(0, 12);
    const token = `${TOKEN_PREFIX}_${tokenPrefix}_${secret}`;
    const credential: CredentialRecord = {
      id,
      agentId: agent.id,
      tokenHash: this.o.tokens.hash(token),
      tokenPrefix,
      label: input.label?.trim() || null,
      createdByActorId: actor.actorId,
      createdAt: now,
      expiresAt:
        input.expiresInDays === undefined
          ? null
          : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000),
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.o.uow.run(async (tx) => {
      await this.o.credentials.insert(tx, credential);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'agent.credential_issued',
        objectType: 'credential',
        objectId: credential.id,
        metadata: {
          agent_id: agent.id,
          token_prefix: tokenPrefix,
          expires_at: credential.expiresAt?.toISOString() ?? null,
        },
      });
    });
    return { credential, token };
  }

  async revokeCredential(actor: ActorContext, credentialId: string): Promise<void> {
    const credential = await this.o.credentials.findById(credentialId);
    if (!credential) throw new DomainError('NOT_FOUND', 'credential not found');
    const agent = await this.require(actor.workspaceId, credential.agentId);
    if (credential.revokedAt) return;
    const now = this.clock.now();
    await this.o.uow.run(async (tx) => {
      await this.o.credentials.revoke(tx, credential.id, now);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'agent.credential_revoked',
        objectType: 'credential',
        objectId: credential.id,
        metadata: { agent_id: agent.id, token_prefix: credential.tokenPrefix },
      });
    });
  }

  /**
   * Resolves a bearer token to its agent. Returns null for unknown, revoked,
   * expired or disabled credentials, without saying which.
   */
  async authenticate(token: string): Promise<ResolvedCredential | null> {
    if (!token.startsWith(`${TOKEN_PREFIX}_`)) return null;
    const resolved = await this.o.credentials.findByTokenHash(this.o.tokens.hash(token));
    if (!resolved) return null;
    const now = this.clock.now();
    if (resolved.credential.revokedAt) return null;
    if (resolved.credential.expiresAt && resolved.credential.expiresAt <= now) return null;
    if (resolved.agent.status !== 'active') return null;
    // Operational timestamps, not ledger events (ADR 0007, section 9).
    await Promise.all([
      this.o.credentials.touchLastUsed(resolved.credential.id, now),
      this.o.agents.touchLastSeen(resolved.agent.id, now),
    ]);
    return resolved;
  }

  private async require(workspaceId: WorkspaceId, agentId: AgentId): Promise<AgentRecord> {
    const agent = await this.o.agents.findById(workspaceId, agentId);
    if (!agent) throw new DomainError('NOT_FOUND', 'agent not found');
    return agent;
  }
}
