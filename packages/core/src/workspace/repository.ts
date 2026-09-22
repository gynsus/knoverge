import type { ActorId, ActorType, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface WorkspaceRecord {
  id: WorkspaceId;
  slug: string;
  name: string;
  description: string | null;
  /** BCP 47 primary language subtag. */
  defaultLanguage: string;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspacePatch = Partial<
  Pick<WorkspaceRecord, 'name' | 'description' | 'defaultLanguage' | 'updatedAt'>
>;

/** What a workspace holds, for a list that has to say so without opening it. */
export interface WorkspaceStats {
  items: number;
  agents: number;
  /** When anything material last happened, from the ledger. Null if nothing has. */
  lastActivityAt: Date | null;
}

export interface WorkspaceRepository {
  insert(tx: Tx, workspace: WorkspaceRecord): Promise<void>;
  update(tx: Tx, id: WorkspaceId, patch: WorkspacePatch): Promise<void>;
  findBySlug(slug: string): Promise<WorkspaceRecord | null>;
  findById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  list(): Promise<WorkspaceRecord[]>;
  /**
   * Counts for several workspaces at once.
   *
   * Three grouped queries whatever the number of workspaces, rather than three
   * per workspace: a list page that asks per row turns one screen into a
   * multiple of round trips for no reason.
   */
  statsFor(workspaceIds: readonly WorkspaceId[]): Promise<Map<WorkspaceId, WorkspaceStats>>;
}

export interface ActorRecord {
  id: ActorId;
  workspaceId: WorkspaceId;
  type: ActorType;
  displayName: string;
  userId: string | null;
  agentId: string | null;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface ActorRepository {
  insert(tx: Tx, actor: ActorRecord): Promise<void>;
  findById(workspaceId: WorkspaceId, id: ActorId, tx?: Tx): Promise<ActorRecord | null>;
  findSystemActor(workspaceId: WorkspaceId): Promise<ActorRecord | null>;
}
