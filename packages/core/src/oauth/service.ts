import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  ActorId,
  AgentId,
  AuthorizationParams,
  ClientRegistrationRequest,
  OauthClientId,
  OauthCodeId,
  OauthGrantId,
  OauthRefreshTokenId,
  UserId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import type {
  AgentRepository,
  CredentialRecord,
  CredentialRepository,
} from '../agents/repository.ts';
import { TOKEN_PREFIX } from '../agents/service.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { TokenService } from '../identity/ports.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { ActorRepository } from '../workspace/repository.ts';
import { OauthFailure } from './errors.ts';
import type {
  OauthClientRecord,
  OauthClientRepository,
  OauthCodeRepository,
  OauthGrantRecord,
  OauthGrantRepository,
  OauthRefreshTokenRepository,
} from './repository.ts';

/**
 * An access token lives an hour.
 *
 * Short because a leaked one cannot be un-leaked before it is noticed, and an
 * hour is what the refresh token is for. Not shorter: every renewal is a round
 * trip, and a connector that renews every few minutes is a connector whose logs
 * nobody can read.
 */
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;

/** A month. Long enough that a connector used weekly still works. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Five minutes between the consent screen and the token request.
 *
 * The client redeems the code the moment the browser hands it back, so this is
 * slack for a slow machine rather than a window anybody uses.
 */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;

/** How long a registration nobody consented to is kept. */
export const UNCONSENTED_CLIENT_TTL_MS = 24 * 60 * 60_000;

const CLIENT_ID_CHARS = 32;

export interface OauthServiceOptions {
  uow: UnitOfWork;
  clients: OauthClientRepository;
  grants: OauthGrantRepository;
  codes: OauthCodeRepository;
  refreshTokens: OauthRefreshTokenRepository;
  credentials: CredentialRepository;
  agents: AgentRepository;
  actors: ActorRepository;
  ledger: EventLedger;
  tokens: TokenService;
  /** The canonical URI of this installation's MCP endpoint. */
  resource: string;
  clock?: Clock;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/** A client, checked against the request that named it. */
export interface CheckedRequest {
  client: OauthClientRecord;
  params: AuthorizationParams;
}

/**
 * Whether two registrations are the same connector coming back.
 *
 * A hosted connector registers itself again every time somebody reconnects it,
 * so its client id says nothing about whether it has been here before. What
 * does: the name it calls itself and the addresses it will accept a code at.
 * Two genuinely different products would have to share both, and sharing a
 * callback address means sharing the service behind it.
 *
 * This is the price of declining Client ID Metadata Documents (ADR 0038),
 * where the client id would have been stable. It is deliberately not a guess:
 * an exact match on both, or nothing.
 */
function sameConnector(a: OauthClientRecord, b: OauthClientRecord): boolean {
  if (a.name !== b.name) return false;
  const left = [...a.redirectUris].sort();
  const right = [...b.redirectUris].sort();
  return left.length === right.length && left.every((uri, i) => uri === right[i]);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The authorization server (ADR 0038).
 *
 * Its whole job is to end in an agent credential. A connector registers, a
 * person consents, and what comes out is a row in `agent_credentials` that
 * `AgentService.authenticate` resolves like any other — so nothing downstream
 * of authentication knows this service exists.
 */
export class OauthService {
  private readonly clock: Clock;

  constructor(private readonly o: OauthServiceOptions) {
    this.clock = o.clock ?? systemClock;
  }

  /**
   * Registers a client, which grants it nothing.
   *
   * The endpoint is open because the hosted connectors depend on it and there
   * is nobody to pre-register them with. What it writes is a name and a
   * redirect URI: no workspace, no agent, no permission and no token.
   */
  async register(input: ClientRegistrationRequest): Promise<{
    record: OauthClientRecord;
    /** Present only for a client that asked to hold one. Shown once. */
    secret: string | undefined;
  }> {
    const wantsSecret = input.token_endpoint_auth_method !== 'none';
    const secret = wantsSecret ? this.o.tokens.generate() : undefined;
    const now = this.clock.now();
    const record: OauthClientRecord = {
      id: newId('oacl') as OauthClientId,
      clientId: this.o.tokens.generate().slice(0, CLIENT_ID_CHARS),
      clientSecretHash: secret ? this.o.tokens.hash(secret) : null,
      name: input.client_name,
      redirectUris: input.redirect_uris,
      tokenEndpointAuthMethod: input.token_endpoint_auth_method,
      createdAt: now,
      lastUsedAt: null,
    };
    await this.o.uow.run((tx) => this.o.clients.insert(tx, record));
    return { record, secret };
  }

  /**
   * Checks an authorization request before a person is shown anything.
   *
   * Everything here is refused without redirecting, because a redirect URI that
   * has not been matched against a registration is an attacker's URI: sending
   * an error to it is the open redirection the specification warns about.
   */
  async check(params: AuthorizationParams): Promise<CheckedRequest> {
    const client = await this.o.clients.findByClientId(params.client_id);
    if (!client) throw new OauthFailure('invalid_client', 'unknown client', 401);
    if (!client.redirectUris.includes(params.redirect_uri)) {
      throw new OauthFailure('invalid_request', 'redirect_uri does not match the registration');
    }
    if (params.resource !== this.o.resource) {
      throw new OauthFailure(
        'invalid_request',
        `this server issues tokens for ${this.o.resource} only`,
      );
    }
    return { client, params };
  }

  /**
   * The live connection this consent would replace, if there is one.
   *
   * Read before anything is written, because it is something the person has to
   * be told: they are about to reconnect something they already have, and a
   * screen that did not say so would leave them with two.
   */
  async replaces(
    checked: CheckedRequest,
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<{ grants: OauthGrantRecord[]; agentName: string } | null> {
    // Newest first, which is the order the repository reads them in: the agent
    // kept is the one the connector was most recently, and every other live
    // connection it holds goes. All of them, not the first found — one left
    // behind is a working refresh token nobody can see.
    const live = await this.o.grants.listLiveForUserInWorkspace(userId, workspaceId);
    const mine: OauthGrantRecord[] = [];
    for (const grant of live) {
      if (grant.clientId === checked.client.id) continue;
      const client = await this.o.clients.findById(grant.clientId);
      if (client && sameConnector(client, checked.client)) mine.push(grant);
    }
    if (mine.length === 0) return null;
    const agent = await this.o.agents.findById(workspaceId, mine[0]!.agentId);
    return { grants: mine, agentName: agent?.name ?? checked.client.name };
  }

  /**
   * A person says yes, in one workspace.
   *
   * Creating the agent is what consent is: the connector had no identity here
   * until somebody gave it one, and from here it is an agent like any other,
   * on the Agents screen, at the tier every agent starts at (rule 5).
   *
   * Reconnecting is not a second connector. A hosted client registers itself
   * again each time, so the same connector arrives under a new client id; the
   * grant it had is retired and the new one points at the agent it already
   * was. Otherwise a person who reconnects twice has three agents and two live
   * connections they cannot see without going looking.
   */
  async consent(
    checked: CheckedRequest,
    actor: ActorContext,
    userId: UserId,
  ): Promise<{ code: string }> {
    const { client, params } = checked;
    const now = this.clock.now();
    const workspaceId = actor.workspaceId;
    const existing = await this.o.grants.findLive(client.id, userId, workspaceId);
    const superseded = existing ? null : await this.replaces(checked, userId, workspaceId);
    const code = this.o.tokens.generate();

    await this.o.uow.run(async (tx) => {
      let grantId: OauthGrantId;
      if (existing) {
        grantId = existing.id;
      } else {
        let agentId: AgentId;
        if (superseded) {
          // The same connector under a new registration. It keeps the agent it
          // already was, so its history reads as one connector rather than as
          // a queue of them, and the connection it held is retired here — the
          // client that registered again has already forgotten it.
          agentId = superseded.grants[0]!.agentId;
          for (const stale of superseded.grants) {
            await this.revokeGrantWithin(tx, stale, now, 'replaced_by_reconnection', actor);
          }
        } else {
          agentId = newId('ag') as AgentId;
          const agentActorId = newId('act') as ActorId;
          const name = await this.agentName(workspaceId, client.name, actor);
          await this.o.actors.insert(tx, {
            id: agentActorId,
            workspaceId,
            type: 'agent',
            displayName: name,
            userId: null,
            agentId,
            createdAt: now,
            disabledAt: null,
          });
          await this.o.agents.insert(tx, {
            id: agentId,
            workspaceId,
            actorId: agentActorId,
            name,
            description: null,
            clientType: null,
            trustTier: 'propose',
            status: 'active',
            createdByActorId: actor.actorId,
            createdAt: now,
            lastSeenAt: null,
            metadata: {},
          });
          await this.o.ledger.append(tx, workspaceId, actor, {
            eventType: 'agent.created',
            objectType: 'agent',
            objectId: agentId,
            metadata: {
              actor_id: agentActorId,
              trust_tier: 'propose',
              oauth_client_id: client.clientId,
            },
          });
        }
        grantId = newId('oagr') as OauthGrantId;
        const grant: OauthGrantRecord = {
          id: grantId,
          clientId: client.id,
          userId,
          workspaceId,
          agentId,
          resource: params.resource,
          scope: params.scope ?? null,
          createdAt: now,
          revokedAt: null,
        };
        await this.o.grants.insert(tx, grant);
      }
      await this.o.codes.insert(tx, {
        id: newId('oacd') as OauthCodeId,
        grantId,
        codeHash: this.o.tokens.hash(code),
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        codeChallengeMethod: 'S256',
        resource: params.resource,
        createdAt: now,
        expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
        consumedAt: null,
      });
      await this.o.clients.touchLastUsed(tx, client.id, now);
    });
    return { code };
  }

  /**
   * Exchanges an authorization code for tokens.
   *
   * The code is spent inside the statement that reads it, so a code presented
   * twice gets nothing the second time. Whether the caller is the client that
   * asked for it is PKCE's answer, not the redirect URI's.
   */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string | undefined;
    redirectUri: string;
    resource: string | undefined;
  }): Promise<IssuedTokens> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);
    const now = this.clock.now();
    // Spending the code is its own transaction, so that a request which fails
    // the checks below still spends it. Rolling it back would hand an attacker
    // holding a stolen code unlimited attempts at the verifier until it expired.
    const code = await this.o.uow.run((tx) =>
      this.o.codes.consume(tx, this.o.tokens.hash(input.code), now),
    );
    if (!code) throw new OauthFailure('invalid_grant', 'the code is unknown, spent or expired');
    if (!equal(code.redirectUri, input.redirectUri)) {
      throw new OauthFailure('invalid_grant', 'redirect_uri does not match the request');
    }
    if (!equal(code.codeChallenge, sha256(input.codeVerifier))) {
      throw new OauthFailure('invalid_grant', 'the verifier does not match the challenge');
    }
    if (input.resource !== undefined && input.resource !== code.resource) {
      throw new OauthFailure('invalid_grant', 'resource does not match the request');
    }
    const grant = await this.liveGrant(code.grantId);
    if (grant.clientId !== client.id) {
      throw new OauthFailure('invalid_grant', 'the code was issued to another client');
    }
    return this.o.uow.run((tx) => this.issue(tx, grant, now, 'code'));
  }

  /**
   * Exchanges a refresh token, and retires it.
   *
   * A token presented after it was exchanged means it was captured, so the
   * grant goes: every refresh token and every access token it issued. The
   * person is left to consent again, which is the only safe answer.
   */
  async refresh(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string | undefined;
    resource: string | undefined;
  }): Promise<IssuedTokens> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);
    const now = this.clock.now();
    const stored = await this.o.refreshTokens.findByTokenHash(
      this.o.tokens.hash(input.refreshToken),
    );
    if (!stored) throw new OauthFailure('invalid_grant', 'unknown refresh token');
    const grant = await this.liveGrant(stored.grantId);
    if (grant.clientId !== client.id) {
      throw new OauthFailure('invalid_grant', 'the token was issued to another client');
    }
    if (input.resource !== undefined && input.resource !== grant.resource) {
      throw new OauthFailure('invalid_grant', 'resource does not match the grant');
    }

    // Retiring the token and issuing its successor are one transaction: a crash
    // between them would leave a connection with a spent token and no new one.
    let replayed = false;
    try {
      return await this.o.uow.run(async (tx) => {
        const next = newId('oart') as OauthRefreshTokenId;
        if (!(await this.o.refreshTokens.rotate(tx, stored.id, next, now))) {
          replayed = true;
          throw new OauthFailure('invalid_grant', 'this refresh token was already used');
        }
        return this.issue(tx, grant, now, 'refresh', next);
      });
    } catch (error) {
      // Already exchanged, or already revoked. Either way somebody else has held
      // this token, and the grant cannot be trusted any further. In its own
      // transaction, because the one above has just rolled back — revoking
      // inside it would roll the revocation back with it, which is the whole
      // point of noticing.
      if (replayed) {
        await this.o.uow.run((tx) =>
          this.revokeGrantWithin(tx, grant, now, 'replayed_refresh_token'),
        );
      }
      throw error;
    }
  }

  /** Revokes a grant and everything it issued (RFC 7009, and the Agents screen). */
  async revokeGrant(grantId: OauthGrantId, reason: string, actor?: ActorContext): Promise<boolean> {
    const grant = await this.o.grants.findById(grantId);
    if (!grant || grant.revokedAt) return false;
    const now = this.clock.now();
    await this.o.uow.run(async (tx) => {
      await this.revokeGrantWithin(tx, grant, now, reason, actor);
    });
    return true;
  }

  /**
   * Finds the grant a token belongs to, for revocation by token (RFC 7009).
   *
   * The specification wants an unknown token to answer success, so that a
   * client cannot learn from the reply whether a token exists.
   */
  async revokeByToken(token: string): Promise<void> {
    const now = this.clock.now();
    const refresh = await this.o.refreshTokens.findByTokenHash(this.o.tokens.hash(token));
    if (refresh) {
      const grant = await this.o.grants.findById(refresh.grantId);
      if (grant && !grant.revokedAt) {
        await this.o.uow.run((tx) => this.revokeGrantWithin(tx, grant, now, 'client_revoked'));
      }
      return;
    }
    const credential = await this.o.credentials.findByTokenHash(this.o.tokens.hash(token));
    if (credential?.credential.oauthGrantId) {
      const grant = await this.o.grants.findById(credential.credential.oauthGrantId);
      if (grant && !grant.revokedAt) {
        await this.o.uow.run((tx) => this.revokeGrantWithin(tx, grant, now, 'client_revoked'));
      }
    }
  }

  /**
   * Mints an access token and the refresh token that will replace it.
   *
   * `from` is the difference between a material change and an authentication.
   * A token exchanged for an authorization code is somebody's consent taking
   * effect, and rule 3 wants that attributable; a token exchanged for a refresh
   * token is the same connection proving it is still itself, which rule 4 says
   * is not a ledger event — and at one an hour per connector it would bury the
   * feed in restatements of a decision made once.
   */
  private async issue(
    tx: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    grant: OauthGrantRecord,
    now: Date,
    from: 'code' | 'refresh',
    refreshTokenId: OauthRefreshTokenId = newId('oart') as OauthRefreshTokenId,
  ): Promise<IssuedTokens> {
    const secret = this.o.tokens.generate();
    const credentialId = newId('cred');
    const tokenPrefix = (credentialId.split('_')[1] ?? credentialId).slice(0, 12);
    const accessToken = `${TOKEN_PREFIX}_${tokenPrefix}_${secret}`;
    const credential: CredentialRecord = {
      id: credentialId,
      agentId: grant.agentId,
      tokenHash: this.o.tokens.hash(accessToken),
      tokenPrefix,
      label: null,
      oauthGrantId: grant.id,
      // The consent is the authority, so the person who gave it is who issued
      // this. Their actor is the one the grant recorded.
      createdByActorId: await this.consentingActor(grant),
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.o.credentials.insert(tx, credential);
    const refreshToken = this.o.tokens.generate();
    await this.o.refreshTokens.insert(tx, {
      id: refreshTokenId,
      grantId: grant.id,
      tokenHash: this.o.tokens.hash(refreshToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      usedAt: null,
      replacedById: null,
      revokedAt: null,
    });
    if (from === 'code') {
      await this.o.ledger.append(
        tx,
        grant.workspaceId,
        { actorId: credential.createdByActorId, requestId: `oauth-${credential.id}` },
        {
          eventType: 'agent.credential_issued',
          objectType: 'credential',
          objectId: credential.id,
          metadata: {
            agent_id: grant.agentId,
            token_prefix: tokenPrefix,
            expires_at: credential.expiresAt?.toISOString() ?? null,
            oauth_grant_id: grant.id,
          },
        },
      );
    }
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  private async consentingActor(grant: OauthGrantRecord): Promise<ActorId> {
    const agent = await this.o.agents.findById(grant.workspaceId, grant.agentId);
    // The agent's creator is the person who consented; falling back to the
    // agent's own actor would attribute the token to the connector itself.
    return (agent?.createdByActorId ?? agent?.actorId) as ActorId;
  }

  private async revokeGrantWithin(
    tx: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    grant: OauthGrantRecord,
    now: Date,
    reason: string,
    actor?: ActorContext,
  ): Promise<void> {
    await this.o.grants.revoke(tx, grant.id, now);
    await this.o.refreshTokens.revokeAllForGrant(tx, grant.id, now);
    const revoked = await this.o.credentials.revokeAllForGrant(tx, grant.id, now);
    const context: ActorContext = actor ?? {
      workspaceId: grant.workspaceId,
      actorId: await this.consentingActor(grant),
      actorType: 'human',
      requestId: `oauth-${grant.id}`,
    };
    await this.o.ledger.append(tx, grant.workspaceId, context, {
      eventType: 'agent.credential_revoked',
      objectType: 'agent',
      objectId: grant.agentId,
      metadata: { oauth_grant_id: grant.id, reason, credentials: revoked },
    });
  }

  private async liveGrant(grantId: OauthGrantId): Promise<OauthGrantRecord> {
    const grant = await this.o.grants.findById(grantId);
    if (!grant || grant.revokedAt) {
      throw new OauthFailure('invalid_grant', 'this connection was disconnected');
    }
    return grant;
  }

  /**
   * Authenticates the client at the token endpoint.
   *
   * A public client proves nothing here and PKCE does the work instead, which
   * is what OAuth 2.1 asks for. A client that registered with a secret must
   * present it, or it is not that client.
   */
  private async authenticateClient(
    clientId: string,
    secret: string | undefined,
  ): Promise<OauthClientRecord> {
    const client = await this.o.clients.findByClientId(clientId);
    if (!client) throw new OauthFailure('invalid_client', 'unknown client', 401);
    if (client.clientSecretHash === null) return client;
    if (!secret || !equal(client.clientSecretHash, this.o.tokens.hash(secret))) {
      throw new OauthFailure('invalid_client', 'client authentication failed', 401);
    }
    return client;
  }

  /**
   * A name for the agent a consent creates.
   *
   * The client's name and the person's, because two people connecting the same
   * connector are two agents and the Agents screen has to tell them apart. A
   * workspace holds one agent per name, so a collision takes a number.
   */
  private async agentName(
    workspaceId: WorkspaceId,
    clientName: string,
    actor: ActorContext,
  ): Promise<string> {
    const who = await this.o.actors.findById(workspaceId, actor.actorId);
    const base = `${clientName} (${who?.displayName ?? 'unknown'})`.slice(0, 116);
    if (!(await this.o.agents.findByName(workspaceId, base))) return base;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base} ${n}`;
      if (!(await this.o.agents.findByName(workspaceId, candidate))) return candidate;
    }
    throw new OauthFailure('server_error', 'too many agents with this name', 500);
  }
}
