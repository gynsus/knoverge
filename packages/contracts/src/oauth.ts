import { z } from 'zod';

import { WorkspaceId } from './ids.ts';

/**
 * How a client proves it is itself at the token endpoint (ADR 0038).
 *
 * `none` is a public client, which is what every hosted connector is: it runs
 * where its secret could be read, so it holds none and PKCE does the work
 * instead. The other two are for a client that can keep one.
 */
export const OauthTokenEndpointAuthMethod = z.enum([
  'none',
  'client_secret_basic',
  'client_secret_post',
]);
export type OauthTokenEndpointAuthMethod = z.infer<typeof OauthTokenEndpointAuthMethod>;

/**
 * The only challenge method this server accepts.
 *
 * OAuth 2.1 requires PKCE and `plain` defeats the point of it, so the list has
 * one entry and the database refuses the rest.
 */
export const OauthCodeChallengeMethod = z.enum(['S256']);
export type OauthCodeChallengeMethod = z.infer<typeof OauthCodeChallengeMethod>;

/**
 * The errors an OAuth endpoint answers with.
 *
 * Not `ErrorCode`. Everything under `/v1` speaks this product's error model,
 * because the caller is an agent or a person's browser and the codes are the
 * product's own. `/oauth/*` speaks OAuth's, because the caller is a connector
 * that was written against the specification and parses these names.
 */
export const OauthErrorCode = z.enum([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
  'invalid_scope',
  'access_denied',
  'temporarily_unavailable',
  'server_error',
]);
export type OauthErrorCode = z.infer<typeof OauthErrorCode>;

export const OauthError = z.object({
  error: OauthErrorCode,
  /** Human-readable, English, and never a hint about somebody else's state. */
  error_description: z.string(),
});
export type OauthError = z.infer<typeof OauthError>;

/**
 * What `/mcp` is, and who issues tokens for it (RFC 9728).
 *
 * The first document a connector reads, because the `WWW-Authenticate` header
 * on an unauthenticated call points at it.
 */
export const ProtectedResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  bearer_methods_supported: z.array(z.string()),
  resource_documentation: z.string().optional(),
});
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadata>;

/** Where the authorization server's endpoints are (RFC 8414). */
export const AuthorizationServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  revocation_endpoint: z.string(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadata>;

/** A redirect URI: `https`, or a literal loopback for a client on this machine. */
export const OauthRedirectUri = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.hash !== '') return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  }, 'a redirect URI must be https, or http on a loopback address, and carry no fragment');

/** Dynamic client registration (RFC 7591). Open, and grants nothing. */
export const ClientRegistrationRequest = z.object({
  client_name: z.string().trim().min(1).max(200),
  redirect_uris: z.array(OauthRedirectUri).min(1).max(10),
  token_endpoint_auth_method: OauthTokenEndpointAuthMethod.default('none'),
  grant_types: z.array(z.string()).max(10).optional(),
  response_types: z.array(z.string()).max(10).optional(),
});
export type ClientRegistrationRequest = z.infer<typeof ClientRegistrationRequest>;

export const ClientRegistrationResponse = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number().int(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: OauthTokenEndpointAuthMethod,
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  /** Only for a client that asked to hold one. Shown once, stored hashed. */
  client_secret: z.string().optional(),
  /** Zero means it does not expire, which is what RFC 7591 says zero means. */
  client_secret_expires_at: z.number().int().optional(),
});
export type ClientRegistrationResponse = z.infer<typeof ClientRegistrationResponse>;

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  refresh_token: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/**
 * What the consent screen shows, for a request that has already been checked.
 *
 * `client_name` is the client's own, which means whoever registered chose it.
 * `redirect_host` is the host the token would actually go to, which is the one
 * part of the request its author cannot misrepresent, and the screen shows both.
 */
export const PendingAuthorization = z.object({
  client_name: z.string(),
  redirect_host: z.string(),
  resource: z.string(),
  /** Workspaces where this person may create an agent, which is what consent does. */
  workspaces: z.array(
    z.object({ workspace_id: WorkspaceId, workspace_slug: z.string(), workspace_name: z.string() }),
  ),
  /**
   * The connection this would replace, per workspace, when there is one.
   *
   * A hosted connector registers itself again every time it is reconnected, so
   * it arrives under a new client id and would otherwise become a second agent
   * beside the one it already is. Consent retires the old connection; the
   * screen says so first, because replacing something silently is how a person
   * ends up with a live connection they cannot see.
   */
  replaces: z.record(WorkspaceId, z.string()),
});
export type PendingAuthorization = z.infer<typeof PendingAuthorization>;

/** The parameters of an authorization request, as the screen hands them back. */
export const AuthorizationParams = z.object({
  client_id: z.string().max(64),
  redirect_uri: OauthRedirectUri,
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: OauthCodeChallengeMethod,
  resource: z.string().max(2000),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
});
export type AuthorizationParams = z.infer<typeof AuthorizationParams>;

export const ConsentRequest = AuthorizationParams.extend({ workspace_id: WorkspaceId });
export type ConsentRequest = z.infer<typeof ConsentRequest>;

/** Where the browser goes next, decided by the server rather than the page. */
export const ConsentResponse = z.object({ redirect_to: z.string() });
export type ConsentResponse = z.infer<typeof ConsentResponse>;
