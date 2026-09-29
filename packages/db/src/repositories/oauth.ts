import type {
  AgentId,
  OauthClientId,
  OauthCodeId,
  OauthGrantId,
  OauthRefreshTokenId,
  UserId,
  WorkspaceId,
} from '@knoverge/contracts';
import type {
  OauthAuthorizationCodeRecord,
  OauthClientRecord,
  OauthClientRepository,
  OauthCodeRepository,
  OauthGrantRecord,
  OauthGrantRepository,
  OauthRefreshTokenRecord,
  OauthRefreshTokenRepository,
  Tx,
} from '@knoverge/core';
import { and, desc, eq, isNull, lt, notExists, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
} from '../schema/oauth.ts';
import { asTx } from '../unit-of-work.ts';

function toClient(row: typeof oauthClients.$inferSelect): OauthClientRecord {
  return {
    id: row.id as OauthClientId,
    clientId: row.clientId,
    clientSecretHash: row.clientSecretHash,
    name: row.name,
    redirectUris: (row.redirectUris as string[]) ?? [],
    tokenEndpointAuthMethod:
      row.tokenEndpointAuthMethod as OauthClientRecord['tokenEndpointAuthMethod'],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function toGrant(row: typeof oauthGrants.$inferSelect): OauthGrantRecord {
  return {
    id: row.id as OauthGrantId,
    clientId: row.clientId as OauthClientId,
    userId: row.userId as UserId,
    workspaceId: row.workspaceId as WorkspaceId,
    agentId: row.agentId as AgentId,
    resource: row.resource,
    scope: row.scope,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function toCode(row: typeof oauthAuthorizationCodes.$inferSelect): OauthAuthorizationCodeRecord {
  return {
    id: row.id as OauthCodeId,
    grantId: row.grantId as OauthGrantId,
    codeHash: row.codeHash,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod as 'S256',
    resource: row.resource,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

function toRefreshToken(row: typeof oauthRefreshTokens.$inferSelect): OauthRefreshTokenRecord {
  return {
    id: row.id as OauthRefreshTokenId,
    grantId: row.grantId as OauthGrantId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    replacedById: row.replacedById as OauthRefreshTokenId | null,
    revokedAt: row.revokedAt,
  };
}

export function createOauthClientRepository(db: Database): OauthClientRepository {
  return {
    async insert(tx: Tx, client: OauthClientRecord) {
      await asTx(tx)
        .insert(oauthClients)
        .values({
          id: client.id,
          clientId: client.clientId,
          clientSecretHash: client.clientSecretHash,
          name: client.name,
          redirectUris: [...client.redirectUris],
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          createdAt: client.createdAt,
          lastUsedAt: client.lastUsedAt,
        });
    },
    async findById(id: OauthClientId) {
      const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
      return row ? toClient(row) : null;
    },
    async findByClientId(clientId: string) {
      const [row] = await db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1);
      return row ? toClient(row) : null;
    },
    async touchLastUsed(tx: Tx, id: OauthClientId, at: Date) {
      await asTx(tx).update(oauthClients).set({ lastUsedAt: at }).where(eq(oauthClients.id, id));
    },
    async deleteUnconsented(tx: Tx, before: Date) {
      const rows = await asTx(tx)
        .delete(oauthClients)
        .where(
          and(
            lt(oauthClients.createdAt, before),
            notExists(
              asTx(tx)
                .select({ one: sql`1` })
                .from(oauthGrants)
                .where(eq(oauthGrants.clientId, oauthClients.id)),
            ),
          ),
        )
        .returning({ id: oauthClients.id });
      return rows.length;
    },
  };
}

export function createOauthGrantRepository(db: Database): OauthGrantRepository {
  return {
    async insert(tx: Tx, grant: OauthGrantRecord) {
      await asTx(tx).insert(oauthGrants).values({
        id: grant.id,
        clientId: grant.clientId,
        userId: grant.userId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        resource: grant.resource,
        scope: grant.scope,
        createdAt: grant.createdAt,
        revokedAt: grant.revokedAt,
      });
    },
    async findById(id: OauthGrantId) {
      const [row] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).limit(1);
      return row ? toGrant(row) : null;
    },
    async findLive(clientId: OauthClientId, userId: UserId, workspaceId: WorkspaceId) {
      const [row] = await db
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.clientId, clientId),
            eq(oauthGrants.userId, userId),
            eq(oauthGrants.workspaceId, workspaceId),
            isNull(oauthGrants.revokedAt),
          ),
        )
        .limit(1);
      return row ? toGrant(row) : null;
    },
    async listForUser(userId: UserId) {
      const rows = await db
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.userId, userId))
        .orderBy(desc(oauthGrants.createdAt));
      return rows.map(toGrant);
    },
    async listForWorkspace(workspaceId: WorkspaceId) {
      const rows = await db
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.workspaceId, workspaceId))
        .orderBy(desc(oauthGrants.createdAt));
      return rows.map(toGrant);
    },
    async revokeAllForAgent(tx: Tx, agentId: AgentId, at: Date) {
      const rows = await asTx(tx)
        .update(oauthGrants)
        .set({ revokedAt: at })
        .where(and(eq(oauthGrants.agentId, agentId), isNull(oauthGrants.revokedAt)))
        .returning({ id: oauthGrants.id });
      return rows.map((row) => row.id as OauthGrantId);
    },
    async revoke(tx: Tx, id: OauthGrantId, at: Date) {
      const rows = await asTx(tx)
        .update(oauthGrants)
        .set({ revokedAt: at })
        .where(and(eq(oauthGrants.id, id), isNull(oauthGrants.revokedAt)))
        .returning({ id: oauthGrants.id });
      return rows.length > 0;
    },
  };
}

/**
 * Takes no database handle, unlike its siblings: every operation on a code is a
 * write inside somebody's transaction. Reading one outside the statement that
 * spends it is exactly what this must not offer.
 */
export function createOauthCodeRepository(): OauthCodeRepository {
  return {
    async insert(tx: Tx, code: OauthAuthorizationCodeRecord) {
      await asTx(tx).insert(oauthAuthorizationCodes).values({
        id: code.id,
        grantId: code.grantId,
        codeHash: code.codeHash,
        redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge,
        codeChallengeMethod: code.codeChallengeMethod,
        resource: code.resource,
        createdAt: code.createdAt,
        expiresAt: code.expiresAt,
        consumedAt: code.consumedAt,
      });
    },
    async consume(tx: Tx, codeHash: string, now: Date) {
      // The tests for unspent and unexpired are in the statement, not around
      // it: two token requests racing on one code must not both be told yes.
      const [row] = await asTx(tx)
        .update(oauthAuthorizationCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthAuthorizationCodes.codeHash, codeHash),
            isNull(oauthAuthorizationCodes.consumedAt),
            sql`${oauthAuthorizationCodes.expiresAt} > ${now}`,
          ),
        )
        .returning();
      return row ? toCode(row) : null;
    },
    async deleteExpired(tx: Tx, before: Date) {
      const rows = await asTx(tx)
        .delete(oauthAuthorizationCodes)
        .where(lt(oauthAuthorizationCodes.expiresAt, before))
        .returning({ id: oauthAuthorizationCodes.id });
      return rows.length;
    },
  };
}

export function createOauthRefreshTokenRepository(db: Database): OauthRefreshTokenRepository {
  return {
    async insert(tx: Tx, token: OauthRefreshTokenRecord) {
      await asTx(tx).insert(oauthRefreshTokens).values({
        id: token.id,
        grantId: token.grantId,
        tokenHash: token.tokenHash,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        usedAt: token.usedAt,
        replacedById: token.replacedById,
        revokedAt: token.revokedAt,
      });
    },
    async findByTokenHash(tokenHash: string) {
      const [row] = await db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
        .limit(1);
      return row ? toRefreshToken(row) : null;
    },
    async rotate(tx: Tx, id: OauthRefreshTokenId, replacedById: OauthRefreshTokenId, at: Date) {
      // Same reason as consuming a code: whether this token was still good is
      // decided by the update, so a captured token cannot be exchanged twice.
      const rows = await asTx(tx)
        .update(oauthRefreshTokens)
        .set({ usedAt: at, replacedById })
        .where(
          and(
            eq(oauthRefreshTokens.id, id),
            isNull(oauthRefreshTokens.usedAt),
            isNull(oauthRefreshTokens.revokedAt),
          ),
        )
        .returning({ id: oauthRefreshTokens.id });
      return rows.length > 0;
    },
    async revokeAllForGrant(tx: Tx, grantId: OauthGrantId, at: Date) {
      const rows = await asTx(tx)
        .update(oauthRefreshTokens)
        .set({ revokedAt: at })
        .where(and(eq(oauthRefreshTokens.grantId, grantId), isNull(oauthRefreshTokens.revokedAt)))
        .returning({ id: oauthRefreshTokens.id });
      return rows.length;
    },
    async deleteExpired(tx: Tx, before: Date) {
      const rows = await asTx(tx)
        .delete(oauthRefreshTokens)
        .where(lt(oauthRefreshTokens.expiresAt, before))
        .returning({ id: oauthRefreshTokens.id });
      return rows.length;
    },
  };
}
