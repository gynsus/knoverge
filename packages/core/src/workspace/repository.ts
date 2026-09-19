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

export interface WorkspaceRepository {
  insert(tx: Tx, workspace: WorkspaceRecord): Promise<void>;
  update(tx: Tx, id: WorkspaceId, patch: WorkspacePatch): Promise<void>;
  findBySlug(slug: string): Promise<WorkspaceRecord | null>;
  findById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  list(): Promise<WorkspaceRecord[]>;
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
  findSystemActor(workspaceId: WorkspaceId): Promise<ActorRecord | null>;
}
