import type { ActorId, CategoryId, WorkspaceId } from '@knoverge/contracts';
import type {
  AliasRecord,
  AliasRepository,
  CategoryPatch,
  CategoryRecord,
  CategoryRepository,
  TaxonomyVersionRepository,
  Tx,
} from '@knoverge/core';
import { and, asc, desc, eq, max, ne, or, sql } from 'drizzle-orm';

import { LOCK_TAXONOMY } from '../locks.ts';

import { DomainError } from '@knoverge/core';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import { categories, categoryAliases, taxonomyVersions } from '../schema/categories.ts';
import { asTx } from '../unit-of-work.ts';

function toCategory(row: typeof categories.$inferSelect): CategoryRecord {
  return {
    ...row,
    id: row.id as CategoryId,
    workspaceId: row.workspaceId as WorkspaceId,
    parentId: row.parentId as CategoryId | null,
    mergedIntoCategoryId: row.mergedIntoCategoryId as CategoryId | null,
    createdByActorId: row.createdByActorId as ActorId,
    approvedByActorId: row.approvedByActorId as ActorId | null,
    status: row.status as CategoryRecord['status'],
  };
}

export function createCategoryRepository(db: Database): CategoryRepository {
  /** The transaction when one is given, otherwise the pool. */
  const reader = (tx?: Tx) => (tx ? asTx(tx) : db);
  return {
    async lock(tx: Tx, workspaceId: WorkspaceId) {
      await asTx(tx).execute(
        sql`SELECT pg_advisory_xact_lock(${LOCK_TAXONOMY}, hashtext(${workspaceId}))`,
      );
    },
    async insert(tx: Tx, category: CategoryRecord) {
      try {
        await asTx(tx).insert(categories).values(category);
      } catch (err) {
        rethrowUniqueViolation(
          err,
          `a category already exists at ${category.path}`,
          { path: category.path },
          'CATEGORY_CONFLICT',
        );
      }
    },
    async update(tx: Tx, id: CategoryId, patch: CategoryPatch) {
      try {
        await asTx(tx)
          .update(categories)
          .set(patch as Partial<typeof categories.$inferInsert>)
          .where(eq(categories.id, id));
      } catch (err) {
        rethrowUniqueViolation(
          err,
          'a category already exists at this path',
          undefined,
          'CATEGORY_CONFLICT',
        );
      }
    },
    async findById(workspaceId: WorkspaceId, id: CategoryId, tx?: Tx) {
      const rows = await reader(tx)
        .select()
        .from(categories)
        .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, id)))
        .limit(1);
      return rows[0] ? toCategory(rows[0]) : null;
    },
    async findByPath(workspaceId: WorkspaceId, path: string, tx?: Tx) {
      const rows = await reader(tx)
        .select()
        .from(categories)
        .where(and(eq(categories.workspaceId, workspaceId), eq(categories.path, path)))
        .limit(1);
      return rows[0] ? toCategory(rows[0]) : null;
    },
    async list(workspaceId: WorkspaceId, options = {}) {
      const where = options.includeArchived
        ? eq(categories.workspaceId, workspaceId)
        : and(eq(categories.workspaceId, workspaceId), ne(categories.status, 'archived'));
      const rows = await db.select().from(categories).where(where).orderBy(asc(categories.path));
      return rows.map(toCategory);
    },
    async listSubtree(workspaceId: WorkspaceId, path: string, tx?: Tx) {
      const rows = await reader(tx)
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.workspaceId, workspaceId),
            or(eq(categories.path, path), sql`${categories.path} LIKE ${`${path}/%`}`),
          ),
        )
        .orderBy(asc(categories.path));
      return rows.map(toCategory);
    },
    async setSubtreeStatus(
      tx: Tx,
      workspaceId: WorkspaceId,
      path: string,
      status: CategoryRecord['status'],
      at: Date,
    ) {
      const rows = await asTx(tx)
        .update(categories)
        .set({ status, updatedAt: at })
        .where(
          and(
            eq(categories.workspaceId, workspaceId),
            or(eq(categories.path, path), sql`${categories.path} LIKE ${`${path}/%`}`),
            ne(categories.status, status),
          ),
        )
        .returning({ id: categories.id });
      return rows.map((r) => r.id as CategoryId);
    },
    async rewriteDescendantPaths(
      tx: Tx,
      workspaceId: WorkspaceId,
      oldPath: string,
      newPath: string,
      at: Date,
    ) {
      try {
        const rows = await asTx(tx)
          .update(categories)
          .set({
            path: sql`${newPath}::text || substring(${categories.path} from ${oldPath.length + 1}::int)`,
            updatedAt: at,
          })
          .where(
            and(
              eq(categories.workspaceId, workspaceId),
              sql`${categories.path} LIKE ${`${oldPath}/%`}`,
            ),
          )
          .returning({ id: categories.id });
        return rows.map((r) => r.id as CategoryId);
      } catch (err) {
        rethrowUniqueViolation(
          err,
          `a category already exists at ${newPath}`,
          { path: newPath },
          'CATEGORY_CONFLICT',
        );
      }
    },
    async rewritePaths(
      tx: Tx,
      workspaceId: WorkspaceId,
      oldPath: string,
      newPath: string,
      at: Date,
    ) {
      // One statement for the whole subtree, so no intermediate state is visible.
      try {
        const rows = await asTx(tx)
          .update(categories)
          .set({
            // Explicit casts: the driver sends both values as untyped parameters.
            path: sql`${newPath}::text || substring(${categories.path} from ${oldPath.length + 1}::int)`,
            updatedAt: at,
          })
          .where(
            and(
              eq(categories.workspaceId, workspaceId),
              or(eq(categories.path, oldPath), sql`${categories.path} LIKE ${`${oldPath}/%`}`),
            ),
          )
          .returning({ id: categories.id });
        if (rows.length === 0) {
          // The caller read this path and decided a rewrite was needed, so no
          // match means the tree changed underneath it. Succeeding here would
          // leave the category's parent and its path disagreeing.
          throw new DomainError(
            'CATEGORY_CONFLICT',
            'the category tree changed while this change was being applied; read it again and retry',
            { objectIds: { path: oldPath } },
          );
        }
        return rows.map((r) => r.id as CategoryId);
      } catch (err) {
        if (err instanceof DomainError) throw err;
        // The path is only ever written here, so this is where a concurrent
        // rename or move collides. Without it the caller would see a 500.
        rethrowUniqueViolation(
          err,
          `a category already exists at ${newPath}`,
          {
            path: newPath,
          },
          'CATEGORY_CONFLICT',
        );
      }
    },
  };
}

export function createAliasRepository(db: Database): AliasRepository {
  const toAlias = (row: typeof categoryAliases.$inferSelect): AliasRecord => ({
    ...row,
    categoryId: row.categoryId as CategoryId,
    workspaceId: row.workspaceId as WorkspaceId,
  });
  return {
    async replaceForCategory(tx: Tx, categoryId: CategoryId, aliases: AliasRecord[]) {
      const t = asTx(tx);
      await t.delete(categoryAliases).where(eq(categoryAliases.categoryId, categoryId));
      if (aliases.length === 0) return;
      try {
        await t.insert(categoryAliases).values(aliases);
      } catch (err) {
        rethrowUniqueViolation(err, 'one of these aliases is already in use');
      }
    },
    async listForWorkspace(workspaceId: WorkspaceId, tx?: Tx) {
      const rows = await (tx ? asTx(tx) : db)
        .select()
        .from(categoryAliases)
        .where(eq(categoryAliases.workspaceId, workspaceId))
        .orderBy(asc(categoryAliases.alias));
      return rows.map(toAlias);
    },
    async findByNormalised(workspaceId: WorkspaceId, normalised: string, tx?: Tx) {
      const rows = await (tx ? asTx(tx) : db)
        .select()
        .from(categoryAliases)
        .where(
          and(
            eq(categoryAliases.workspaceId, workspaceId),
            eq(categoryAliases.normalisedAlias, normalised),
          ),
        )
        .limit(1);
      return rows[0] ? toAlias(rows[0]) : null;
    },
  };
}

export function createTaxonomyVersionRepository(db: Database): TaxonomyVersionRepository {
  return {
    async current(workspaceId: WorkspaceId, tx?: Tx) {
      const [row] = await (tx ? asTx(tx) : db)
        .select({ version: max(taxonomyVersions.version) })
        .from(taxonomyVersions)
        .where(eq(taxonomyVersions.workspaceId, workspaceId));
      return row?.version ?? 0;
    },
    async latest(workspaceId: WorkspaceId) {
      const rows = await db
        .select({
          version: taxonomyVersions.version,
          gitCommitHash: taxonomyVersions.gitCommitHash,
        })
        .from(taxonomyVersions)
        .where(eq(taxonomyVersions.workspaceId, workspaceId))
        .orderBy(desc(taxonomyVersions.version))
        .limit(1);
      return rows[0] ?? null;
    },
    async bump(tx: Tx, workspaceId: WorkspaceId, at: Date, version: number, gitCommitHash: string) {
      // The unique index on (workspace, version) is the backstop: if two
      // writers ever reached here with one number, the second fails rather
      // than quietly sharing a version with a different commit.
      await asTx(tx)
        .insert(taxonomyVersions)
        .values({ workspaceId, version, gitCommitHash, createdAt: at });
    },
  };
}
