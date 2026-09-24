import type { ActorId, ActorType, UserId, WorkspaceId } from '@knoverge/contracts';

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
  /**
   * When the workspace was archived, or null while it is live.
   *
   * An archived workspace is read-only: its knowledge, history and ledger stay
   * exactly as they were and every write is refused. The state is reversible,
   * which is why this is a date and not a deletion.
   */
  archivedAt: Date | null;
}

export type WorkspacePatch = Partial<
  Pick<WorkspaceRecord, 'name' | 'description' | 'defaultLanguage' | 'updatedAt' | 'archivedAt'>
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
  /** Every actor in the workspace, for turning an id in an event into a name. */
  listForWorkspace(workspaceId: WorkspaceId): Promise<ActorRecord[]>;
  /**
   * Renames this person's actor in every workspace they belong to.
   *
   * An actor carries a copy of the name the account had when the membership
   * was made, and one actor exists per workspace. Leaving the copies behind
   * would let somebody correct their name and still see the old one against
   * everything they had ever done.
   *
   * No event is rewritten: an event stores an actor id, and the name is
   * resolved when it is read. This changes how the same person is shown, not
   * what happened.
   */
  renameForUser(tx: Tx, userId: UserId, displayName: string): Promise<number>;
}
