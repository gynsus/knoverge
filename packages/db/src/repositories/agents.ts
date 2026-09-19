import type { ActorId, AgentId, WorkspaceId } from '@knoverge/contracts';
import type {
  AgentPatch,
  AgentRecord,
  AgentRepository,
  CredentialRecord,
  CredentialRepository,
  ResolvedCredential,
  Tx,
} from '@knoverge/core';
import { and, asc, count, eq, gt, isNull, or } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import { agentCredentials, agents } from '../schema/agents.ts';
import { asTx } from '../unit-of-work.ts';

function toAgent(row: typeof agents.$inferSelect): AgentRecord {
  return {
    ...row,
    id: row.id as AgentId,
    workspaceId: row.workspaceId as WorkspaceId,
    actorId: row.actorId as ActorId,
    createdByActorId: row.createdByActorId as ActorId,
    trustTier: row.trustTier as AgentRecord['trustTier'],
    status: row.status as AgentRecord['status'],
  };
}

function toCredential(row: typeof agentCredentials.$inferSelect): CredentialRecord {
  return {
    ...row,
    agentId: row.agentId as AgentId,
    createdByActorId: row.createdByActorId as ActorId,
  };
}

export function createAgentRepository(db: Database): AgentRepository {
  return {
    async insert(tx: Tx, agent: AgentRecord) {
      try {
        await asTx(tx).insert(agents).values(agent);
      } catch (err) {
        rethrowUniqueViolation(err, `an agent named "${agent.name}" already exists`);
      }
    },
    async update(tx: Tx, workspaceId: WorkspaceId, id: AgentId, patch: AgentPatch) {
      try {
        await asTx(tx)
          .update(agents)
          .set(patch)
          .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
      } catch (err) {
        rethrowUniqueViolation(err, 'an agent with this name already exists');
      }
    },
    async findById(workspaceId: WorkspaceId, id: AgentId) {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)))
        .limit(1);
      return rows[0] ? toAgent(rows[0]) : null;
    },
    async findByName(workspaceId: WorkspaceId, name: string) {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)))
        .limit(1);
      return rows[0] ? toAgent(rows[0]) : null;
    },
    async list(workspaceId: WorkspaceId) {
      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.workspaceId, workspaceId))
        .orderBy(asc(agents.createdAt));
      return rows.map(toAgent);
    },
    async touchLastSeen(id: AgentId, at: Date) {
      await db.update(agents).set({ lastSeenAt: at }).where(eq(agents.id, id));
    },
  };
}

export function createCredentialRepository(db: Database): CredentialRepository {
  return {
    async insert(tx: Tx, credential: CredentialRecord) {
      await asTx(tx).insert(agentCredentials).values(credential);
    },
    async findByTokenHash(tokenHash: string): Promise<ResolvedCredential | null> {
      const rows = await db
        .select({ credential: agentCredentials, agent: agents })
        .from(agentCredentials)
        .innerJoin(agents, eq(agents.id, agentCredentials.agentId))
        .where(eq(agentCredentials.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      return row ? { credential: toCredential(row.credential), agent: toAgent(row.agent) } : null;
    },
    async findById(id: string) {
      const rows = await db
        .select()
        .from(agentCredentials)
        .where(eq(agentCredentials.id, id))
        .limit(1);
      return rows[0] ? toCredential(rows[0]) : null;
    },
    async listForAgent(agentId: AgentId) {
      const rows = await db
        .select()
        .from(agentCredentials)
        .where(eq(agentCredentials.agentId, agentId))
        .orderBy(asc(agentCredentials.createdAt));
      return rows.map(toCredential);
    },
    async countActive(agentId: AgentId, now: Date) {
      const [row] = await db
        .select({ n: count() })
        .from(agentCredentials)
        .where(
          and(
            eq(agentCredentials.agentId, agentId),
            isNull(agentCredentials.revokedAt),
            or(isNull(agentCredentials.expiresAt), gt(agentCredentials.expiresAt, now)),
          ),
        );
      return row?.n ?? 0;
    },
    async revoke(tx: Tx, id: string, at: Date) {
      const rows = await asTx(tx)
        .update(agentCredentials)
        .set({ revokedAt: at })
        .where(and(eq(agentCredentials.id, id), isNull(agentCredentials.revokedAt)))
        .returning({ id: agentCredentials.id });
      return rows.length > 0;
    },
    async revokeAllForAgent(tx: Tx, agentId: AgentId, at: Date) {
      const rows = await asTx(tx)
        .update(agentCredentials)
        .set({ revokedAt: at })
        .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
        .returning({ id: agentCredentials.id });
      return rows.length;
    },
    async touchLastUsed(id: string, at: Date) {
      await db.update(agentCredentials).set({ lastUsedAt: at }).where(eq(agentCredentials.id, id));
    },
  };
}
