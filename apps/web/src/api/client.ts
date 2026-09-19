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
    headers: { accept: 'application/json' },
    signal: signal ?? null,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/**
 * POST with the CSRF token; fetches a token first when none is cached and
 * retries once when the server rejects a stale token.
 */
export async function apiPost<T>(url: string, body: unknown, retry = true): Promise<T> {
  const token = csrfToken ?? (await fetchCsrfToken());
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': token,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 403 && retry) {
    const error = await parseError(res);
    if (error.code === 'FORBIDDEN' && !csrfWasFresh(token)) {
      await fetchCsrfToken();
      return apiPost<T>(url, body, false);
    }
    throw error;
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

function csrfWasFresh(token: string): boolean {
  return token !== csrfToken;
}

/** Test hook: forget the cached CSRF token. */
export function resetCsrfToken(): void {
  csrfToken = undefined;
}
