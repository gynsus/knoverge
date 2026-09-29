import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { agents } from './agents.ts';
import { id, timestampTz } from './common.ts';
import { users } from './users.ts';
import { workspaces } from './workspaces.ts';

/**
 * A client that registered itself (ADR 0038).
 *
 * Registration is open and grants nothing: a row here holds no workspace, no
 * agent and no permission, and can do nothing but ask a person for consent.
 * Everything in it except the id was supplied by whoever sent the request.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: id('id').primaryKey(),
    /** What the client calls itself in a request; the id is ours, this is the protocol's. */
    clientId: varchar('client_id', { length: 64 }).notNull().unique(),
    /** Null for a public client, which is what every hosted connector is. */
    clientSecretHash: varchar('client_secret_hash', { length: 128 }),
    /**
     * The client's own `client_name`. Attacker-supplied text that a person will
     * be shown, so it is stored as given and displayed as untrusted.
     */
    name: varchar('name', { length: 200 }).notNull(),
    /** Matched exactly, as whole strings. */
    redirectUris: jsonb('redirect_uris').notNull().default([]),
    tokenEndpointAuthMethod: varchar('token_endpoint_auth_method', { length: 32 })
      .notNull()
      .default('none'),
    createdAt: timestampTz('created_at').notNull(),
    /** When a token was last issued for it. Null while nobody has consented. */
    lastUsedAt: timestampTz('last_used_at'),
  },
  (t) => [index('oauth_clients_created_idx').on(t.createdAt)],
);

/**
 * One person letting one client into one workspace, and the agent that made it.
 *
 * The grant is the consent. Revoking it is what revokes the connection, and the
 * credentials it issued go with it.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: id('id').primaryKey(),
    // No cascade. The job that clears away registrations deletes only clients
    // nobody consented to, and this is what makes that true rather than
    // intended: deleting one that holds a grant fails.
    clientId: id('client_id')
      .notNull()
      .references(() => oauthClients.id),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** The agent this client acts as, created by the consent that made this row. */
    agentId: id('agent_id')
      .notNull()
      .references(() => agents.id),
    /** The canonical URI the tokens are good for, and nothing else. */
    resource: text('resource').notNull(),
    scope: text('scope'),
    createdAt: timestampTz('created_at').notNull(),
    revokedAt: timestampTz('revoked_at'),
  },
  (t) => [
    index('oauth_grants_client_idx').on(t.clientId),
    index('oauth_grants_user_idx').on(t.userId),
    index('oauth_grants_agent_idx').on(t.agentId),
    // Consenting again to the same client, person and workspace resumes the
    // grant that is already there. Without this a person who reconnects three
    // times is three actors in the ledger, which is three answers to one
    // question about who wrote something.
    uniqueIndex('oauth_grants_live_idx')
      .on(t.clientId, t.userId, t.workspaceId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * An authorization code, between the redirect and the token request.
 *
 * Stored as a hash and good once: the row records when it was spent, so a code
 * presented twice is a replay rather than a second token.
 */
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: id('id').primaryKey(),
    grantId: id('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 128 }).notNull().unique(),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),
    codeChallengeMethod: varchar('code_challenge_method', { length: 8 }).notNull(),
    resource: text('resource').notNull(),
    createdAt: timestampTz('created_at').notNull(),
    expiresAt: timestampTz('expires_at').notNull(),
    consumedAt: timestampTz('consumed_at'),
  },
  (t) => [index('oauth_authorization_codes_expires_idx').on(t.expiresAt)],
);

/**
 * A refresh token, which rotates.
 *
 * Using one retires it and records what took its place. Presenting a retired
 * token means it was captured, so the whole grant goes.
 */
export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: id('id').primaryKey(),
    grantId: id('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    createdAt: timestampTz('created_at').notNull(),
    expiresAt: timestampTz('expires_at').notNull(),
    /** When it was exchanged. A token with this set is spent, not valid. */
    usedAt: timestampTz('used_at'),
    replacedById: id('replaced_by_id'),
    revokedAt: timestampTz('revoked_at'),
  },
  (t) => [
    index('oauth_refresh_tokens_grant_idx').on(t.grantId),
    uniqueIndex('oauth_refresh_tokens_replaced_idx').on(t.replacedById),
  ],
);
