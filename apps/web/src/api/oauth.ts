import type {
  AuthorizationParams,
  ConsentRequest,
  ConsentResponse,
  PendingAuthorization,
} from '@knoverge/contracts';

import { apiGet, apiPost } from './client.ts';

/**
 * The consent screen's own calls (ADR 0038).
 *
 * These are `/v1`, not `/oauth`: the caller here is this interface, so they
 * carry the session cookie, the CSRF token and the workspace header like every
 * other call, and they answer in this product's error shape. The connector
 * never sees them — it only ever sees the redirect they end in.
 */
export const oauthApi = {
  pending: (params: AuthorizationParams, signal?: AbortSignal) =>
    apiGet<PendingAuthorization>(
      `/v1/admin/oauth.pending?${new URLSearchParams(params as Record<string, string>).toString()}`,
      signal,
    ),
  consent: (body: ConsentRequest) =>
    apiPost<ConsentResponse>('/v1/admin/oauth.consent', body, body.workspace_id),
  deny: (body: AuthorizationParams) => apiPost<ConsentResponse>('/v1/admin/oauth.deny', body),
};
