import type { ActorId, CategoryId, CategoryStatus, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface CategoryRecord {
  id: CategoryId;
  workspaceId: WorkspaceId;
  parentId: CategoryId | null;
  slug: string;
  path: string;
  name: string;
  description: string | null;
  inclusionGuidance: string[];
  exclusionGuidance: string[];
  status: CategoryStatus;
  mergedIntoCategoryId: CategoryId | null;
  createdByActorId: ActorId;
  approvedByActorId: ActorId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CategoryPatch = Partial<
  Pick<
    CategoryRecord,
    | 'slug'
    | 'path'
    | 'name'
    | 'description'
    | 'inclusionGuidance'
    | 'exclusionGuidance'
    | 'status'
    | 'parentId'
    | 'updatedAt'
  >
>;

export interface CategoryRepository {
  insert(tx: Tx, category: CategoryRecord): Promise<void>;
  update(tx: Tx, id: CategoryId, patch: CategoryPatch): Promise<void>;
  findById(workspaceId: WorkspaceId, id: CategoryId): Promise<CategoryRecord | null>;
  findByPath(workspaceId: WorkspaceId, path: string): Promise<CategoryRecord | null>;
  list(
    workspaceId: WorkspaceId,
    options?: { includeArchived?: boolean },
  ): Promise<CategoryRecord[]>;
  /** The category itself and everything beneath it, ordered by path. */
  listSubtree(workspaceId: WorkspaceId, path: string): Promise<CategoryRecord[]>;
  /**
   * Rewrites the path prefix of a subtree in one statement. Returns the number
   * of rows changed, including the category itself.
   */
  rewritePaths(
    tx: Tx,
    workspaceId: WorkspaceId,
    oldPath: string,
    newPath: string,
    at: Date,
  ): Promise<number>;
  /** Sets the status of a subtree in one statement. Returns the number of rows changed. */
  setSubtreeStatus(
    tx: Tx,
    workspaceId: WorkspaceId,
    path: string,
    status: CategoryStatus,
    at: Date,
  ): Promise<number>;
}

export interface AliasRecord {
  id: string;
  categoryId: CategoryId;
  workspaceId: WorkspaceId;
  alias: string;
  normalisedAlias: string;
  createdAt: Date;
}

export interface AliasRepository {
  replaceForCategory(tx: Tx, categoryId: CategoryId, aliases: AliasRecord[]): Promise<void>;
  listForWorkspace(workspaceId: WorkspaceId): Promise<AliasRecord[]>;
  findByNormalised(workspaceId: WorkspaceId, normalised: string): Promise<AliasRecord | null>;
}

export interface TaxonomyVersionRepository {
  current(workspaceId: WorkspaceId): Promise<number>;
  /** Inserts the next version inside the caller's transaction and returns it. */
  bump(tx: Tx, workspaceId: WorkspaceId, at: Date): Promise<number>;
}
