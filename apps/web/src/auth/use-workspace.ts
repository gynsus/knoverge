import type { PermissionAction, WorkspaceResponse } from '@knoverge/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { adminApi } from '../api/admin.ts';
import { currentWorkspace, setWorkspace } from '../api/client.ts';
import { AUTH_QUERY_KEY, useAuth } from './use-auth.ts';

export const WORKSPACE_KEY = ['workspace'] as const;
const STORAGE_KEY = 'knoverge.workspace';

/** Remembered per browser, so a reload stays in the workspace you were in. */
function remembered(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A private window or blocked storage: the choice simply does not persist.
  }
}

export interface WorkspaceContext {
  /** The workspaces this person belongs to. */
  available: { id: string; slug: string; name: string }[];
  selectedId: string | undefined;
  select(id: string): void;
  workspace: WorkspaceResponse['workspace'] | undefined;
  /** True when the caller holds the action somewhere in this workspace. */
  can(action: PermissionAction): boolean;
  isPending: boolean;
  error: unknown;
}

/**
 * The workspace the interface is showing, and what the caller may do in it.
 *
 * The server refuses a person who belongs to several workspaces and names none,
 * so a selection has to exist before any workspace-scoped request is made. What
 * the caller may do comes from the server rather than from their role: deciding
 * it here from the role would be a second copy of the policy engine, and it
 * would be wrong for anyone whose permissions were adjusted by a grant.
 */
export function useWorkspaceContext(): WorkspaceContext {
  const auth = useAuth();
  const client = useQueryClient();
  const memberships = auth.state.kind === 'authenticated' ? auth.state.me.memberships : [];
  const available = memberships.map((m) => ({
    id: m.workspace_id,
    slug: m.workspace_slug,
    name: m.workspace_name,
  }));

  // Only an explicit choice is state. Everything else is derived, so a
  // membership removed while the tab is open simply stops being chosen, with
  // no state to reset and no cascading render.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const fallback = available.find((w) => w.id === remembered())?.id ?? available[0]?.id;
  const effective = available.some((w) => w.id === chosen) ? chosen : fallback;
  // Set during render, so the first request of this render already carries it.
  if (currentWorkspace() !== effective) setWorkspace(effective);
  useEffect(() => {
    if (currentWorkspace() !== effective) setWorkspace(effective);
  }, [effective]);

  const query = useQuery({
    queryKey: [...WORKSPACE_KEY, effective],
    queryFn: ({ signal }) => adminApi.workspace.get(signal),
    enabled: effective !== undefined,
  });

  const held = new Set<string>(query.data?.permissions ?? []);
  return {
    available,
    selectedId: effective,
    select: (id) => {
      remember(id);
      setWorkspace(id);
      setChosen(id);
      // Nothing cached belongs to the new workspace. The page keys are not
      // scoped by workspace, so without this the agents, categories, rules and
      // members of the old one stay on screen under the new one's name — and
      // acting on a row would post an id from one workspace with the other's
      // header.
      //
      // Reset rather than remove: the page stays mounted across the switch, and
      // removing a query an observer is still watching clears it without asking
      // for it again.
      void client.resetQueries({ predicate: (q) => q.queryKey[0] !== AUTH_QUERY_KEY[0] });
    },
    workspace: query.data?.workspace,
    can: (action) => held.has(action),
    isPending: query.isPending,
    error: query.isError ? query.error : undefined,
  };
}
