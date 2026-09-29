import type {
  AgentId,
  OauthClientId,
  OauthCodeId,
  OauthGrantId,
  OauthRefreshTokenId,
  UserId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/**
 * A client that registered itself (ADR 0038).
 *
 * Everything here except the id arrived in an unauthenticated request, and none
 * of it grants anything: the row is a name and a redirect URI until a person
 * consents.
 */
export interface OauthClientRecord {
  id: OauthClientId;
  /** The identifier the client sends. The id column is ours; this is the protocol's. */
  clientId: string;
  /** Null for a public client, which is what every hosted connector is. */
  clientSecretHash: string | null;
  /** The client's own `client_name`. Shown to a person, trusted by nothing. */
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** One person letting one client into one workspace, and the agent it made. */
export interface OauthGrantRecord {
  id: OauthGrantId;
  clientId: OauthClientId;
  userId: UserId;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  /** The canonical URI the tokens are good for, and nothing else. */
  resource: string;
  scope: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface OauthAuthorizationCodeRecord {
  id: OauthCodeId;
  grantId: OauthGrantId;
  codeHash: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface OauthRefreshTokenRecord {
  id: OauthRefreshTokenId;
  grantId: OauthGrantId;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  /** When it was exchanged. A token with this set is spent, not valid. */
  usedAt: Date | null;
  replacedById: OauthRefreshTokenId | null;
  revokedAt: Date | null;
}

export interface OauthClientRepository {
  insert(tx: Tx, client: OauthClientRecord): Promise<void>;
  findById(id: OauthClientId): Promise<OauthClientRecord | null>;
  findByClientId(clientId: string): Promise<OauthClientRecord | null>;
  touchLastUsed(tx: Tx, id: OauthClientId, at: Date): Promise<void>;
  /**
   * Registrations nobody consented to, older than `before`, removed.
   *
   * Registration is open, so registrations accumulate. One that holds a grant is
   * kept as long as the grant is, which the foreign key enforces rather than
   * this statement promising it.
   */
  deleteUnconsented(tx: Tx, before: Date): Promise<number>;
}

export interface OauthGrantRepository {
  insert(tx: Tx, grant: OauthGrantRecord): Promise<void>;
  findById(id: OauthGrantId): Promise<OauthGrantRecord | null>;
  /** The grant this client, person and workspace already have, if it is live. */
  findLive(
    clientId: OauthClientId,
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<OauthGrantRecord | null>;
  /** What a person has connected, for the screen that lets them disconnect it. */
  listForUser(userId: UserId): Promise<OauthGrantRecord[]>;
  listForWorkspace(workspaceId: WorkspaceId): Promise<OauthGrantRecord[]>;
  /** False when it was already revoked and nothing changed. */
  revoke(tx: Tx, id: OauthGrantId, at: Date): Promise<boolean>;
}

export interface OauthCodeRepository {
  insert(tx: Tx, code: OauthAuthorizationCodeRecord): Promise<void>;
  /**
   * Spends the code, and returns it only if this call is what spent it.
   *
   * The unspent and unexpired test is inside the statement, so two token
   * requests racing on one code cannot both be told yes. A caller that gets
   * null is looking at a replay.
   */
  consume(tx: Tx, codeHash: string, now: Date): Promise<OauthAuthorizationCodeRecord | null>;
  deleteExpired(tx: Tx, before: Date): Promise<number>;
}

export interface OauthRefreshTokenRepository {
  insert(tx: Tx, token: OauthRefreshTokenRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<OauthRefreshTokenRecord | null>;
  /**
   * Retires a token and records what took its place, if it was still unused.
   *
   * False means somebody presented a token that had already been exchanged,
   * which is the signal the grant was captured.
   */
  rotate(
    tx: Tx,
    id: OauthRefreshTokenId,
    replacedById: OauthRefreshTokenId,
    at: Date,
  ): Promise<boolean>;
  revokeAllForGrant(tx: Tx, grantId: OauthGrantId, at: Date): Promise<number>;
  deleteExpired(tx: Tx, before: Date): Promise<number>;
}
