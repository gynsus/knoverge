import { z } from 'zod';

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
