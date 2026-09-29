import {
  AuthorizationParams,
  AuthorizationServerMetadata,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  ConsentRequest,
  ConsentResponse,
  PendingAuthorization,
  ProtectedResourceMetadata,
  TokenResponse,
  type OauthError,
} from '@knoverge/contracts';
import { DomainError, OauthFailure } from '@knoverge/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { requireUser } from '../plugins/auth-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

/** Where the consent screen lives in the web interface. */
export const CONSENT_PATH = '/oauth/consent';

/** Registration is unauthenticated, so it is the one endpoint held tightest. */
const REGISTER_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const TOKEN_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

/** The document a `WWW-Authenticate` challenge points at (RFC 9728). */
export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * An OAuth endpoint's refusal, in OAuth's words.
 *
 * The caller is a connector written against the specification: it reads
 * `error`, and this product's error codes would mean nothing to it.
 */
function failure(error: unknown): { status: number; body: OauthError } {
  if (error instanceof OauthFailure) {
    return {
      status: error.status,
      body: { error: error.code, error_description: error.description },
    };
  }
  // Everything the framework refused before the handler ran: a malformed body,
  // a missing parameter, a caller past its budget. Answered in OAuth's words
  // and at the status the framework chose, because a client that is being
  // rate limited has to be able to tell that from a server that broke.
  const status =
    typeof (error as { statusCode?: number }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
  if (status === 429) {
    return {
      status,
      body: { error: 'temporarily_unavailable', error_description: 'too many requests' },
    };
  }
  if (status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: status === 401 ? 'invalid_client' : 'invalid_request',
        error_description: (error as Error).message || 'the request could not be understood',
      },
    };
  }
  return {
    status: 500,
    body: { error: 'server_error', error_description: 'an unexpected failure' },
  };
}

/** Client credentials from the Basic header, when a client sends them there. */
function basicCredentials(request: FastifyRequest): { id: string; secret: string } | null {
  const header = request.headers.authorization;
  if (!header?.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return null;
  return {
    id: decodeURIComponent(decoded.slice(0, split)),
    secret: decodeURIComponent(decoded.slice(split + 1)),
  };
}

const TokenForm = z.object({
  grant_type: z.string().max(64),
  code: z.string().max(200).optional(),
  code_verifier: z.string().min(43).max(128).optional(),
  refresh_token: z.string().max(200).optional(),
  redirect_uri: z.string().max(2000).optional(),
  client_id: z.string().max(64).optional(),
  client_secret: z.string().max(200).optional(),
  resource: z.string().max(2000).optional(),
});

const RevokeForm = z.object({
  token: z.string().max(200),
  token_type_hint: z.string().max(32).optional(),
  client_id: z.string().max(64).optional(),
  client_secret: z.string().max(200).optional(),
});

/**
 * The authorization server, and the documents that lead a connector to it.
 *
 * Registered in a scope of its own for two reasons: these routes answer in
 * OAuth's error shape rather than this product's, and they accept a form body,
 * which nothing else here does. Both are contained by the encapsulation rather
 * than leaking into every other route.
 */
export async function registerOauthRoutes(app: FastifyInstance, services: Services): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );
    scope.setErrorHandler((error, request, reply) => {
      if (!(error instanceof OauthFailure)) {
        request.log.error({ err: error }, 'oauth endpoint failed');
      }
      const { status, body } = failure(error);
      void reply.code(status).send(body);
    });

    const r = scope.withTypeProvider<ZodTypeProvider>();
    const issuer = services.issuer;
    // Hidden from the generated API description throughout. That document
    // describes `/v1`, whose every route answers in this product's error shape
    // and takes this product's headers; these answer in OAuth's and take none
    // of them. What describes this surface is the two metadata documents below,
    // which is what a connector reads anyway.

    const resourceDocument = {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    };
    // Both spellings: RFC 9728 inserts the resource's path into the well-known
    // path, and clients differ on whether they ask for the plain one.
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      r.get(
        path,
        { schema: { hide: true, response: { 200: ProtectedResourceMetadata } } },
        async () => resourceDocument,
      );
    }

    r.get(
      '/.well-known/oauth-authorization-server',
      { schema: { hide: true, response: { 200: AuthorizationServerMetadata } } },
      async () => ({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: [
          'none',
          'client_secret_basic',
          'client_secret_post',
        ],
        // S256 only. OAuth 2.1 requires PKCE and `plain` defeats the point.
        code_challenge_methods_supported: ['S256'],
      }),
    );

    r.post(
      '/oauth/register',
      {
        config: { rateLimit: REGISTER_LIMIT },
        schema: {
          hide: true,
          body: ClientRegistrationRequest,
          response: { 201: ClientRegistrationResponse },
        },
      },
      async (request, reply) => {
        const { record, secret } = await services.oauth.register(request.body);
        return reply.code(201).send({
          client_id: record.clientId,
          client_id_issued_at: Math.floor(record.createdAt.getTime() / 1000),
          client_name: record.name,
          redirect_uris: record.redirectUris,
          token_endpoint_auth_method: record.tokenEndpointAuthMethod,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        });
      },
    );

    /**
     * The authorization endpoint hands the browser to the consent screen.
     *
     * Everything refused here is refused without redirecting: a redirect URI
     * that has not been matched against a registration is an attacker's URI,
     * and sending an error to it is the open redirection to avoid. Once the
     * client and its URI check out, the person decides, and the screen is where
     * that happens.
     */
    r.get(
      '/oauth/authorize',
      { schema: { hide: true, querystring: AuthorizationParams } },
      async (request, reply) => {
        const params = request.query;
        await services.oauth.check(params);
        const next = new URL(`${issuer}${CONSENT_PATH}`);
        for (const [key, value] of Object.entries(params)) {
          if (typeof value === 'string') next.searchParams.set(key, value);
        }
        return reply.redirect(next.toString(), 302);
      },
    );

    r.post(
      '/oauth/token',
      {
        config: { rateLimit: TOKEN_LIMIT },
        schema: { hide: true, body: TokenForm, response: { 200: TokenResponse } },
      },
      async (request, reply) => {
        const body = request.body;
        const basic = basicCredentials(request);
        const clientId = basic?.id ?? body.client_id;
        const clientSecret = basic?.secret ?? body.client_secret;
        if (!clientId) throw new OauthFailure('invalid_client', 'client_id is required', 401);

        let issued;
        if (body.grant_type === 'authorization_code') {
          if (!body.code || !body.code_verifier || !body.redirect_uri) {
            throw new OauthFailure(
              'invalid_request',
              'code, code_verifier and redirect_uri are required',
            );
          }
          issued = await services.oauth.exchangeCode({
            code: body.code,
            codeVerifier: body.code_verifier,
            clientId,
            clientSecret,
            redirectUri: body.redirect_uri,
            resource: body.resource,
          });
        } else if (body.grant_type === 'refresh_token') {
          if (!body.refresh_token) {
            throw new OauthFailure('invalid_request', 'refresh_token is required');
          }
          issued = await services.oauth.refresh({
            refreshToken: body.refresh_token,
            clientId,
            clientSecret,
            resource: body.resource,
          });
        } else {
          throw new OauthFailure(
            'unsupported_grant_type',
            'this server issues tokens for authorization_code and refresh_token',
          );
        }
        // A token response is never cached, by anybody, anywhere.
        void reply.header('cache-control', 'no-store');
        return {
          access_token: issued.accessToken,
          token_type: 'Bearer' as const,
          expires_in: issued.expiresInSeconds,
          refresh_token: issued.refreshToken,
        };
      },
    );

    r.post(
      '/oauth/revoke',
      { schema: { hide: true, body: RevokeForm } },
      async (request, reply) => {
        // An unknown token answers success, so that a caller cannot learn from
        // the reply whether a token exists (RFC 7009).
        await services.oauth.revokeByToken(request.body.token);
        return reply.code(200).send({});
      },
    );
  });
}

/**
 * The consent screen's own calls, which are this product's API and not OAuth's.
 *
 * They need a signed-in person, CSRF protection and the permission that creates
 * an agent, because that is what consenting does.
 */
export function registerConsentRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/oauth.pending',
    {
      onRequest: requireUser,
      schema: { querystring: AuthorizationParams, response: { 200: PendingAuthorization } },
    },
    async (request) => {
      const human = request.humanAuth;
      if (!human) throw new DomainError('UNAUTHENTICATED', 'sign in required');
      const { client, params } = await services.oauth
        .check(request.query)
        .catch((error: unknown) => {
          // The screen is this product's, so it hears about this in this
          // product's words; the connector never sees this call.
          throw error instanceof OauthFailure
            ? new DomainError('VALIDATION_ERROR', error.description)
            : error;
        });
      const memberships = await services.repositories.memberships.listForUser(human.user.id);
      const allowed = [];
      for (const membership of memberships) {
        const context = {
          workspaceId: membership.workspaceId,
          actorId: membership.actorId,
          actorType: 'human' as const,
          requestId: request.id,
        };
        if (
          await services.authorization.mayList(context, { role: membership.role }, 'agent.manage')
        ) {
          allowed.push({
            workspace_id: membership.workspaceId,
            workspace_slug: membership.workspaceSlug,
            workspace_name: membership.workspaceName,
          });
        }
      }
      return {
        client_name: client.name,
        redirect_host: new URL(params.redirect_uri).host,
        resource: params.resource,
        workspaces: allowed,
      };
    },
  );

  r.post(
    '/v1/admin/oauth.consent',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: ConsentRequest, response: { 200: ConsentResponse } },
    },
    async (request) => {
      const { workspace_id: _workspaceId, ...params } = request.body;
      const checked = await services.oauth.check(params).catch((error: unknown) => {
        throw error instanceof OauthFailure
          ? new DomainError('VALIDATION_ERROR', error.description)
          : error;
      });
      const human = request.humanAuth;
      if (!human) throw new DomainError('UNAUTHENTICATED', 'sign in required');
      // The workspace comes from the body, and the permission is checked in it:
      // consent creates an agent, so it takes what creating an agent takes.
      const actor = await requirePermission(services, request, 'agent.manage');
      const { code } = await services.oauth.consent(checked, actor.context, human.user.id);
      const to = new URL(params.redirect_uri);
      to.searchParams.set('code', code);
      if (params.state !== undefined) to.searchParams.set('state', params.state);
      return { redirect_to: to.toString() };
    },
  );

  r.post(
    '/v1/admin/oauth.deny',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: AuthorizationParams, response: { 200: ConsentResponse } },
    },
    async (request) => {
      // Checked even to say no: the URI a refusal goes to has to be one the
      // client registered, or the refusal itself is an open redirect.
      await services.oauth.check(request.body).catch((error: unknown) => {
        throw error instanceof OauthFailure
          ? new DomainError('VALIDATION_ERROR', error.description)
          : error;
      });
      const to = new URL(request.body.redirect_uri);
      to.searchParams.set('error', 'access_denied');
      if (request.body.state !== undefined) to.searchParams.set('state', request.body.state);
      return { redirect_to: to.toString() };
    },
  );

  r.get(
    '/v1/admin/oauth.grants',
    {
      schema: {
        response: {
          200: z.object({
            grants: z.array(
              z.object({
                grant_id: z.string(),
                client_name: z.string(),
                agent_id: z.string(),
                created_at: z.iso.datetime(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const grants = await services.repositories.oauthGrants.listForWorkspace(
        actor.context.workspaceId,
      );
      const live = grants.filter((g) => g.revokedAt === null);
      return {
        grants: await Promise.all(
          live.map(async (g) => ({
            grant_id: g.id,
            client_name:
              (await services.repositories.oauthClients.findById(g.clientId))?.name ?? 'unknown',
            agent_id: g.agentId,
            created_at: g.createdAt.toISOString(),
          })),
        ),
      };
    },
  );

  r.post(
    '/v1/admin/oauth.disconnect',
    {
      onRequest: csrfUnlessBearer(app),
      schema: {
        body: z.object({ grant_id: z.string().max(40) }),
        response: { 200: z.object({ disconnected: z.boolean() }) },
      },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'agent.manage');
      const grant = await services.repositories.oauthGrants.findById(
        request.body.grant_id as never,
      );
      if (!grant || grant.workspaceId !== actor.context.workspaceId) {
        throw new DomainError('NOT_FOUND', 'connection not found');
      }
      const disconnected = await services.oauth.revokeGrant(
        grant.id,
        'disconnected_by_person',
        actor.context,
      );
      return { disconnected };
    },
  );
}

/** Kept beside the routes it belongs to: the challenge `/mcp` answers with. */
export function challengeFor(services: Services): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(services.issuer)}"`;
}
