import type { MeResponse } from '@knoverge/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { authApi } from '../api/auth.ts';
import { ApiRequestError } from '../api/client.ts';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; me: MeResponse }
  | { kind: 'error' };

export const AUTH_QUERY_KEY = ['auth'] as const;

async function loadAuth(signal: AbortSignal): Promise<AuthState> {
  try {
    const status = await authApi.status(signal);
    if (status.bootstrap_required) return { kind: 'setup' };
    if (!status.authenticated) return { kind: 'anonymous' };
    return { kind: 'authenticated', me: await authApi.me(signal) };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) return { kind: 'anonymous' };
    return { kind: 'error' };
  }
}

export interface Auth {
  state: AuthState;
  refresh(): Promise<void>;
  setMe(me: MeResponse): void;
  logout(): Promise<void>;
}

/**
 * Authentication state shared by every component through the query cache:
 * setup required, anonymous, or signed in with the current user.
 */
export function useAuth(): Auth {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: ({ signal }) => loadAuth(signal),
    staleTime: 60_000,
  });
  return {
    state: query.data ?? { kind: 'loading' },
    refresh: async () => {
      await client.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
    setMe: (me) => {
      const next: AuthState = { kind: 'authenticated', me };
      client.setQueryData(AUTH_QUERY_KEY, next);
    },
    logout: async () => {
      await authApi.logout();
      const next: AuthState = { kind: 'anonymous' };
      client.setQueryData(AUTH_QUERY_KEY, next);
    },
  };
}
