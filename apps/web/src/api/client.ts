import { ApiError, type ErrorCode } from '@knoverge/contracts';

/** Thrown for every non-2xx response; carries the shared error payload. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

let csrfToken: string | undefined;

/**
 * The workspace every request applies to.
 *
 * The server refuses a person who belongs to more than one workspace and names
 * none, so without this the whole interface stopped working for them the moment
 * they were added to a second one.
 */
let workspaceId: string | undefined;

export function setWorkspace(id: string | undefined): void {
  workspaceId = id;
}

export function currentWorkspace(): string | undefined {
  return workspaceId;
}

/**
 * `override` is for an action taken on a workspace other than the one being
 * looked at — archiving one from the list, for instance. Choosing it first and
 * posting straight after would send the old header: the choice reaches the
 * client on the next render, and the request does not wait for one.
 */
function scopeHeaders(override?: string): Record<string, string> {
  const id = override ?? workspaceId;
  return id ? { 'x-knoverge-workspace': id } : {};
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch('/v1/auth/csrf', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('could not obtain a CSRF token');
  const body = (await res.json()) as { token: string };
  csrfToken = body.token;
  return body.token;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }
  const parsed = ApiError.safeParse(payload);
  return new ApiRequestError(
    res.status,
    parsed.success
      ? parsed.data
      : { code: 'INTERNAL_ERROR', message: `HTTP ${res.status}`, retryable: res.status >= 500 },
  );
}

export async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...scopeHeaders() },
    signal: signal ?? null,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/**
 * POST with the CSRF token. When a cached token is rejected, fetches a fresh
 * one and retries exactly once; a token fetched inside this call is never
 * retried, so a genuine FORBIDDEN surfaces immediately.
 */
export async function apiPost<T>(url: string, body: unknown, workspace?: string): Promise<T> {
  const cached = csrfToken;
  const res = await postOnce(url, body, cached ?? (await fetchCsrfToken()), workspace);
  if (res.status === 403 && cached !== undefined) {
    const retried = await postOnce(url, body, await fetchCsrfToken(), workspace);
    if (!retried.ok) throw await parseError(retried);
    return (await retried.json()) as T;
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

function postOnce(
  url: string,
  body: unknown,
  token: string,
  workspace?: string,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': token,
      ...scopeHeaders(workspace),
    },
    body: JSON.stringify(body ?? {}),
  });
}

/** Test hook: forget the cached CSRF token and the chosen workspace. */
export function resetCsrfToken(): void {
  csrfToken = undefined;
  workspaceId = undefined;
}
