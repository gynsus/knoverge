import type { MeResponse } from '@knoverge/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { authApi } from '../api/auth.ts';
import { ApiRequestError, setWorkspace } from '../api/client.ts';

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
    // A cancelled request is not an answer. Returning a state here stored it as
    // a successful query result, so an aborted fetch painted "the server could
    // not be reached" until something invalidated it.
    if (signal.aborted) throw err;
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
      try {
        await authApi.logout();
      } finally {
        // Whatever the server said, this browser is done with that session.
        // Everything cached belongs to the person signing out: the member list,
        // their sessions, the agents. Clearing only the auth key left the next
        // person on this browser looking at it.
        setWorkspace(undefined);
        // Everything cached belongs to the person signing out: the member list,
        // their sessions, the agents. Clearing only the auth key left the next
        // person on this browser looking at it. The auth entry itself is
        // replaced rather than removed, so the interface goes straight to the
        // sign-in page instead of flickering through a reload.
        client.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_QUERY_KEY[0] });
        client.setQueryData(AUTH_QUERY_KEY, { kind: 'anonymous' } satisfies AuthState);
      }
    },
  };
}
