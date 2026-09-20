import type {
  ActorId,
  CategoryId,
  Frontmatter,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';
import type {
  ItemCategoryRecord,
  KnowledgeItemRecord,
  KnowledgeRepository,
  ListItemsOptions,
  RevisionRecord,
  RevisionRepository,
  Tx,
} from '@knoverge/core';
import { newId } from '@knoverge/core';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { rethrowUniqueViolation } from '../errors.ts';
import {
  knowledgeItemCategories,
  knowledgeItemTags,
  knowledgeItems,
  knowledgeRevisions,
  tags,
} from '../schema/knowledge.ts';
import { asTx } from '../unit-of-work.ts';

function toItem(row: typeof knowledgeItems.$inferSelect): KnowledgeItemRecord {
  return {
    ...row,
    workspaceId: row.workspaceId as WorkspaceId,
    id: row.id as KnowledgeItemId,
    currentRevisionId: row.currentRevisionId as RevisionId | null,
    createdByActorId: row.createdByActorId as ActorId,
    type: row.type as KnowledgeItemRecord['type'],
    status: row.status as KnowledgeItemRecord['status'],
    reviewState: row.reviewState as KnowledgeItemRecord['reviewState'],
    evidenceState: row.evidenceState as KnowledgeItemRecord['evidenceState'],
  };
}

function toRevision(row: typeof knowledgeRevisions.$inferSelect): RevisionRecord {
  return {
    ...row,
    id: row.id as RevisionId,
    knowledgeItemId: row.knowledgeItemId as KnowledgeItemId,
    workspaceId: row.workspaceId as WorkspaceId,
    createdByActorId: row.createdByActorId as ActorId,
    frontmatter: row.frontmatter as Frontmatter,
    changeKind: row.changeKind as RevisionRecord['changeKind'],
  };
}

/** Tags are matched case- and space-insensitively, and stored as given. */
const normalise = (tag: string): string => tag.trim().toLowerCase();

export function createKnowledgeRepository(db: Database): KnowledgeRepository {
  const reader = (tx?: Tx) => (tx ? asTx(tx) : db);
  return {
    async insert(tx: Tx, item: KnowledgeItemRecord) {
      try {
        await asTx(tx).insert(knowledgeItems).values(item);
      } catch (err) {
        rethrowUniqueViolation(err, 'an item already exists at that path', {
          path: item.markdownPath,
        });
      }
    },
    async update(tx, id, patch) {
      await asTx(tx)
        .update(knowledgeItems)
        .set(patch as Partial<typeof knowledgeItems.$inferInsert>)
        .where(eq(knowledgeItems.id, id));
    },
    async findById(workspaceId, id, tx) {
      const rows = await reader(tx)
        .select()
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.workspaceId, workspaceId), eq(knowledgeItems.id, id)))
        .limit(1);
      return rows[0] ? toItem(rows[0]) : null;
    },
    async findByPath(workspaceId, markdownPath, tx) {
      const rows = await reader(tx)
        .select()
        .from(knowledgeItems)
        .where(
          and(
            eq(knowledgeItems.workspaceId, workspaceId),
            eq(knowledgeItems.markdownPath, markdownPath),
          ),
        )
        .limit(1);
      return rows[0] ? toItem(rows[0]) : null;
    },
    async list(workspaceId: WorkspaceId, options: ListItemsOptions = {}) {
      const where = [eq(knowledgeItems.workspaceId, workspaceId)];
      if (options.status) where.push(eq(knowledgeItems.status, options.status));
      // Ids are ULIDs, so ordering by id is ordering by creation time and the
      // cursor is the last id of the previous page.
      if (options.after) where.push(gt(knowledgeItems.id, options.after));
      if (options.categoryId) {
        const ids = db
          .select({ id: knowledgeItemCategories.knowledgeItemId })
          .from(knowledgeItemCategories)
          .where(eq(knowledgeItemCategories.categoryId, options.categoryId));
        where.push(inArray(knowledgeItems.id, ids));
      }
      const rows = await db
        .select()
        .from(knowledgeItems)
        .where(and(...where))
        .orderBy(asc(knowledgeItems.id))
        .limit(Math.min(options.limit ?? 50, 200));
      return rows.map(toItem);
    },
    async slugsInDirectory(workspaceId, directory, tx) {
      const rows = await reader(tx)
        .select({ slug: knowledgeItems.slug })
        .from(knowledgeItems)
        .where(
          and(
            eq(knowledgeItems.workspaceId, workspaceId),
            sql`${knowledgeItems.markdownPath} LIKE ${`${directory}/%`}`,
          ),
        );
      return rows.map((r) => r.slug);
    },

    async setCategories(tx: Tx, itemId: KnowledgeItemId, rows: ItemCategoryRecord[]) {
      const t = asTx(tx);
      await t
        .delete(knowledgeItemCategories)
        .where(eq(knowledgeItemCategories.knowledgeItemId, itemId));
      if (rows.length > 0) await t.insert(knowledgeItemCategories).values(rows);
    },
    async categoriesOf(workspaceId, itemIds) {
      if (itemIds.length === 0) return [];
      const rows = await db
        .select()
        .from(knowledgeItemCategories)
        .where(inArray(knowledgeItemCategories.knowledgeItemId, [...itemIds]))
        .orderBy(asc(knowledgeItemCategories.position));
      return rows.map((r) => ({
        ...r,
        knowledgeItemId: r.knowledgeItemId as KnowledgeItemId,
        categoryId: r.categoryId as CategoryId,
      }));
    },

    async setTags(tx: Tx, workspaceId: WorkspaceId, itemId: KnowledgeItemId, list) {
      const t = asTx(tx);
      await t.delete(knowledgeItemTags).where(eq(knowledgeItemTags.knowledgeItemId, itemId));
      if (list.length === 0) return;
      const wanted = [...new Map(list.map((tag) => [normalise(tag), tag])).entries()];
      // Upsert by the normalised name, then read back: another write may have
      // created the same tag, and the unique index is what decides.
      await t
        .insert(tags)
        .values(
          wanted.map(([normalisedName, name]) => ({
            id: newId('tag'),
            workspaceId,
            name,
            normalisedName,
          })),
        )
        .onConflictDoNothing();
      const existing = await t
        .select({ id: tags.id, normalisedName: tags.normalisedName })
        .from(tags)
        .where(
          and(
            eq(tags.workspaceId, workspaceId),
            inArray(
              tags.normalisedName,
              wanted.map(([n]) => n),
            ),
          ),
        );
      await t
        .insert(knowledgeItemTags)
        .values(existing.map((tag) => ({ knowledgeItemId: itemId, tagId: tag.id })));
    },
    async tagsOf(workspaceId, itemIds) {
      const result = new Map<KnowledgeItemId, string[]>();
      if (itemIds.length === 0) return result;
      const rows = await db
        .select({ itemId: knowledgeItemTags.knowledgeItemId, name: tags.name })
        .from(knowledgeItemTags)
        .innerJoin(tags, eq(tags.id, knowledgeItemTags.tagId))
        .where(inArray(knowledgeItemTags.knowledgeItemId, [...itemIds]))
        .orderBy(asc(tags.normalisedName));
      for (const row of rows) {
        const id = row.itemId as KnowledgeItemId;
        result.set(id, [...(result.get(id) ?? []), row.name]);
      }
      return result;
    },
  };
}

export function createRevisionRepository(db: Database): RevisionRepository {
  const reader = (tx?: Tx) => (tx ? asTx(tx) : db);
  return {
    async insert(tx: Tx, revision: RevisionRecord) {
      await asTx(tx).insert(knowledgeRevisions).values(revision);
    },
    async findById(workspaceId, id, tx) {
      const rows = await reader(tx)
        .select()
        .from(knowledgeRevisions)
        .where(and(eq(knowledgeRevisions.workspaceId, workspaceId), eq(knowledgeRevisions.id, id)))
        .limit(1);
      return rows[0] ? toRevision(rows[0]) : null;
    },
    async listForItem(itemId, limit = 50) {
      const rows = await db
        .select()
        .from(knowledgeRevisions)
        .where(eq(knowledgeRevisions.knowledgeItemId, itemId))
        .orderBy(desc(knowledgeRevisions.revisionNumber))
        .limit(Math.min(limit, 200));
      return rows.map(toRevision);
    },
    async latestCommit(workspaceId, tx) {
      const rows = await reader(tx)
        .select({ hash: knowledgeRevisions.gitCommitHash })
        .from(knowledgeRevisions)
        .where(eq(knowledgeRevisions.workspaceId, workspaceId))
        .orderBy(desc(knowledgeRevisions.createdAt))
        .limit(1);
      return rows[0]?.hash ?? null;
    },
  };
}
