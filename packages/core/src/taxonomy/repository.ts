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
  /**
   * Takes the workspace's taxonomy lock for the rest of the transaction.
   *
   * A mutation validates against the tree and then rewrites it, so the check
   * and the act have to be one step. Without this the lock was taken when the
   * version was allocated, near the end, and serialised only the version
   * number: two mutations could each validate against a tree the other was
   * about to change.
   */
  lock(tx: Tx, workspaceId: WorkspaceId): Promise<void>;
  /**
   * Reads pass the transaction when they are part of a check-then-act. Without
   * it they go through the pool and cannot see what the transaction holding the
   * lock has already written.
   */
  findById(workspaceId: WorkspaceId, id: CategoryId, tx?: Tx): Promise<CategoryRecord | null>;
  findByPath(workspaceId: WorkspaceId, path: string, tx?: Tx): Promise<CategoryRecord | null>;
  list(
    workspaceId: WorkspaceId,
    options?: { includeArchived?: boolean },
  ): Promise<CategoryRecord[]>;
  /** The category itself and everything beneath it, ordered by path. */
  listSubtree(workspaceId: WorkspaceId, path: string, tx?: Tx): Promise<CategoryRecord[]>;
  /**
   * Rewrites the path prefix of a subtree in one statement. Returns the ids it
   * changed, including the category itself, so the caller reports what actually
   * moved rather than a snapshot read before the statement.
   *
   * Throws when it matches nothing: the caller only asks for a rewrite it
   * believes is needed, so matching no row means the tree is not what the
   * caller read, and silently succeeding would leave a path and a parent that
   * disagree.
   */
  rewritePaths(
    tx: Tx,
    workspaceId: WorkspaceId,
    oldPath: string,
    newPath: string,
    at: Date,
  ): Promise<CategoryId[]>;
  /**
   * The same rewrite for everything *below* a category, leaving the category
   * itself alone, and matching nothing is not an error.
   *
   * A rename changes the slug and the path together, and the database checks
   * that a path ends in its slug, so the category's own row has to be written
   * in one statement. Its descendants keep their own slugs and are rewritten
   * separately.
   */
  rewriteDescendantPaths(
    tx: Tx,
    workspaceId: WorkspaceId,
    oldPath: string,
    newPath: string,
    at: Date,
  ): Promise<CategoryId[]>;
  /** Sets the status of a subtree in one statement. Returns the ids it changed. */
  setSubtreeStatus(
    tx: Tx,
    workspaceId: WorkspaceId,
    path: string,
    status: CategoryStatus,
    at: Date,
  ): Promise<CategoryId[]>;
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
  findByNormalised(
    workspaceId: WorkspaceId,
    normalised: string,
    tx?: Tx,
  ): Promise<AliasRecord | null>;
}

export interface TaxonomyVersionRepository {
  current(workspaceId: WorkspaceId, tx?: Tx): Promise<number>;
  /**
   * Inserts the next version inside the caller's transaction and returns it.
   * The caller holds the taxonomy lock, so the number cannot be claimed twice.
   */
  bump(tx: Tx, workspaceId: WorkspaceId, at: Date): Promise<number>;
}
