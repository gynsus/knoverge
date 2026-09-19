import {
  CategoryAlias,
  CategoryName,
  CategoryPath,
  CategorySlug,
  Guidance,
  type CategoryId,
  type WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type {
  AliasRecord,
  AliasRepository,
  CategoryPatch,
  CategoryRecord,
  CategoryRepository,
  TaxonomyVersionRepository,
} from './repository.ts';

export const MAX_CATEGORY_DEPTH = 8;

export interface TaxonomyServiceOptions {
  uow: UnitOfWork;
  categories: CategoryRepository;
  aliases: AliasRepository;
  versions: TaxonomyVersionRepository;
  ledger: EventLedger;
  clock?: Clock;
}

export interface CreateCategoryInput {
  name: string;
  parentPath?: string | undefined;
  slug?: string | undefined;
  description?: string | undefined;
  inclusionGuidance?: string[] | undefined;
  exclusionGuidance?: string[] | undefined;
  aliases?: string[] | undefined;
}

export interface UpdateCategoryInput {
  categoryId: CategoryId;
  name?: string | undefined;
  slug?: string | undefined;
  description?: string | null | undefined;
  inclusionGuidance?: string[] | undefined;
  exclusionGuidance?: string[] | undefined;
  aliases?: string[] | undefined;
}

export interface CategoryWithAliases extends CategoryRecord {
  aliases: string[];
}

export interface TaxonomyResult {
  category: CategoryWithAliases;
  taxonomyVersion: number;
}

/** Aliases match case-insensitively and ignore surrounding and repeated spaces. */
export function normaliseAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFC');
}

/**
 * Cyrillic to Latin, so a Russian category name yields a readable identifier
 * rather than an empty one. Other scripts fall back to a generated slug.
 */
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Derives a slug from a name. Returns an empty string when nothing
 * transliterable remains; callers then fall back to a generated identifier.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Drop combining marks so "Ü" becomes "u", not "u-".
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\u0400-\u04ff]/g, (char) => CYRILLIC[char] ?? '-')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '')
  );
}

/**
 * Curated category tree of a workspace. Every mutation bumps the taxonomy
 * version and records a ledger event in the same transaction.
 */
export class TaxonomyService {
  private readonly o: TaxonomyServiceOptions;
  private readonly clock: Clock;

  constructor(options: TaxonomyServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  currentVersion(workspaceId: WorkspaceId): Promise<number> {
    return this.o.versions.current(workspaceId);
  }

  async list(
    workspaceId: WorkspaceId,
    options: {
      rootPath?: string | undefined;
      depth?: number | undefined;
      includeArchived?: boolean;
    } = {},
  ): Promise<CategoryWithAliases[]> {
    const all = await this.o.categories.list(workspaceId, {
      includeArchived: options.includeArchived ?? false,
    });
    const aliases = await this.o.aliases.listForWorkspace(workspaceId);
    const byCategory = new Map<string, string[]>();
    for (const alias of aliases) {
      byCategory.set(alias.categoryId, [...(byCategory.get(alias.categoryId) ?? []), alias.alias]);
    }
    const root = options.rootPath;
    const depth = options.depth;
    return all
      .filter((c) => {
        if (root !== undefined && c.path !== root && !c.path.startsWith(`${root}/`)) return false;
        if (depth === undefined) return true;
        const base = root === undefined ? 0 : root.split('/').length;
        return c.path.split('/').length - base <= depth;
      })
      .map((c) => ({ ...c, aliases: byCategory.get(c.id) ?? [] }));
  }

  async get(workspaceId: WorkspaceId, categoryId: CategoryId): Promise<CategoryWithAliases | null> {
    const category = await this.o.categories.findById(workspaceId, categoryId);
    if (!category) return null;
    const aliases = await this.o.aliases.listForWorkspace(workspaceId);
    return {
      ...category,
      aliases: aliases.filter((a) => a.categoryId === category.id).map((a) => a.alias),
    };
  }

  /**
   * Every mutation validates against the tree and then rewrites it, so both
   * happen inside one transaction that holds the workspace's taxonomy lock from
   * its first statement. Reading first and writing afterwards let two mutations
   * each validate against a tree the other was about to change: a move could
   * reparent a category whose path another rename had already rewritten,
   * leaving the parent and the path disagreeing, and two moves could make each
   * other's parent and produce a cycle.
   */
  async create(actor: ActorContext, input: CreateCategoryInput): Promise<TaxonomyResult> {
    const name = this.parseName(input.name);
    const id = newId('cat') as CategoryId;
    // A name in a script we cannot transliterate still deserves a usable category.
    const derived = input.slug ?? slugify(name);
    const slug = this.parseSlug(derived === '' ? fallbackSlug(id) : derived);
    const now = this.clock.now();

    return this.o.uow.run(async (tx) => {
      await this.o.categories.lock(tx, actor.workspaceId);
      const parent = await this.resolveParent(actor.workspaceId, input.parentPath, tx);
      if (parent && parent.status !== 'active') {
        throw new DomainError('CATEGORY_CONFLICT', 'the parent category is not active');
      }
      const path = parent ? `${parent.path}/${slug}` : slug;
      this.parsePath(path);
      if (path.split('/').length > MAX_CATEGORY_DEPTH) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `categories may not nest deeper than ${MAX_CATEGORY_DEPTH}`,
        );
      }
      if (await this.o.categories.findByPath(actor.workspaceId, path, tx)) {
        throw new DomainError('CATEGORY_CONFLICT', `a category already exists at ${path}`, {
          objectIds: { path },
        });
      }
      const aliases = await this.parseAliases(actor.workspaceId, input.aliases ?? [], null, tx);
      const category: CategoryRecord = {
        id,
        workspaceId: actor.workspaceId,
        parentId: parent?.id ?? null,
        slug,
        path,
        name,
        description: input.description?.trim() || null,
        inclusionGuidance: this.parseGuidance(input.inclusionGuidance),
        exclusionGuidance: this.parseGuidance(input.exclusionGuidance),
        // Direct creation by an authorised human; agent proposals arrive with the review workflow.
        status: 'active',
        mergedIntoCategoryId: null,
        createdByActorId: actor.actorId,
        approvedByActorId: actor.actorType === 'human' ? actor.actorId : null,
        createdAt: now,
        updatedAt: now,
      };
      await this.o.categories.insert(tx, category);
      await this.writeAliases(tx, category, aliases, now);
      const taxonomyVersion = await this.o.versions.bump(tx, actor.workspaceId, now);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'category.created',
        objectType: 'category',
        objectId: category.id,
        categoryIds: [category.id],
        metadata: {
          path,
          taxonomy_version: taxonomyVersion,
          ...(parent ? { parent_id: parent.id } : {}),
        },
      });
      return { category: { ...category, aliases }, taxonomyVersion };
    });
  }

  async update(actor: ActorContext, input: UpdateCategoryInput): Promise<TaxonomyResult> {
    const now = this.clock.now();
    return this.o.uow.run(async (tx) => {
      await this.o.categories.lock(tx, actor.workspaceId);
      const category = await this.require(actor.workspaceId, input.categoryId, tx);
      const patch: CategoryPatch = {};
      if (input.name !== undefined) patch.name = this.parseName(input.name);
      if (input.description !== undefined) patch.description = input.description?.trim() || null;
      if (input.inclusionGuidance !== undefined) {
        patch.inclusionGuidance = this.parseGuidance(input.inclusionGuidance);
      }
      if (input.exclusionGuidance !== undefined) {
        patch.exclusionGuidance = this.parseGuidance(input.exclusionGuidance);
      }
      let newPath: string | undefined;
      if (input.slug !== undefined) {
        const slug = this.parseSlug(input.slug);
        if (slug !== category.slug) {
          patch.slug = slug;
          newPath = this.pathWithSlug(category, slug);
          if (await this.o.categories.findByPath(actor.workspaceId, newPath, tx)) {
            throw new DomainError('CATEGORY_CONFLICT', `a category already exists at ${newPath}`);
          }
        }
      }
      const aliases =
        input.aliases === undefined
          ? undefined
          : await this.parseAliases(actor.workspaceId, input.aliases, category.id, tx);
      if (Object.keys(patch).length === 0 && aliases === undefined) {
        return {
          category: await this.withAliases(category),
          taxonomyVersion: await this.o.versions.current(actor.workspaceId, tx),
        };
      }

      patch.updatedAt = now;
      if (newPath) {
        // Descendants first, then this category's slug and path in one
        // statement: the database checks that a path ends in its own slug, so
        // writing the slug and the path separately would break it in between.
        await this.o.categories.rewriteDescendantPaths(
          tx,
          actor.workspaceId,
          category.path,
          newPath,
          now,
        );
        patch.path = newPath;
      }
      await this.o.categories.update(tx, category.id, patch);
      if (aliases !== undefined) {
        await this.writeAliases(tx, category, aliases, now);
      }
      const taxonomyVersion = await this.o.versions.bump(tx, actor.workspaceId, now);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'category.updated',
        objectType: 'category',
        objectId: category.id,
        categoryIds: [category.id],
        metadata: {
          changed: [
            ...Object.keys(patch).filter((k) => k !== 'updatedAt'),
            ...(aliases ? ['aliases'] : []),
          ].sort(),
          taxonomy_version: taxonomyVersion,
          ...(newPath ? { path: newPath, previous_path: category.path } : {}),
        },
      });
      const updated = await this.require(actor.workspaceId, category.id, tx);
      return {
        category: { ...updated, aliases: aliases ?? (await this.withAliases(updated)).aliases },
        taxonomyVersion,
      };
    });
  }

  /** Reparents a category and rewrites the paths of its whole subtree. */
  async move(
    actor: ActorContext,
    categoryId: CategoryId,
    newParentId: CategoryId | null,
  ): Promise<TaxonomyResult> {
    const now = this.clock.now();
    return this.o.uow.run(async (tx) => {
      await this.o.categories.lock(tx, actor.workspaceId);
      const category = await this.require(actor.workspaceId, categoryId, tx);
      const parent =
        newParentId === null ? null : await this.require(actor.workspaceId, newParentId, tx);
      if (parent) {
        if (parent.id === category.id) {
          throw new DomainError('VALIDATION_ERROR', 'a category cannot be its own parent');
        }
        if (parent.path === category.path || parent.path.startsWith(`${category.path}/`)) {
          throw new DomainError('VALIDATION_ERROR', 'a category cannot move into its own subtree');
        }
        if (parent.status !== 'active') {
          throw new DomainError('CATEGORY_CONFLICT', 'the parent category is not active');
        }
      }
      if ((parent?.id ?? null) === category.parentId) {
        return {
          category: await this.withAliases(category),
          taxonomyVersion: await this.o.versions.current(actor.workspaceId, tx),
        };
      }
      const newPath = parent ? `${parent.path}/${category.slug}` : category.slug;
      const subtree = await this.o.categories.listSubtree(actor.workspaceId, category.path, tx);
      const deepest = Math.max(
        ...subtree.map(
          (c) =>
            newPath.split('/').length + c.path.split('/').length - category.path.split('/').length,
        ),
      );
      if (deepest > MAX_CATEGORY_DEPTH) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `the move would nest deeper than ${MAX_CATEGORY_DEPTH}`,
        );
      }
      if (await this.o.categories.findByPath(actor.workspaceId, newPath, tx)) {
        throw new DomainError('CATEGORY_CONFLICT', `a category already exists at ${newPath}`);
      }

      await this.o.categories.update(tx, category.id, {
        parentId: parent?.id ?? null,
        updatedAt: now,
      });
      const moved = await this.o.categories.rewritePaths(
        tx,
        actor.workspaceId,
        category.path,
        newPath,
        now,
      );
      const taxonomyVersion = await this.o.versions.bump(tx, actor.workspaceId, now);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'category.moved',
        objectType: 'category',
        objectId: category.id,
        // The ids the statement actually touched, not a snapshot read before it.
        categoryIds: moved,
        metadata: {
          previous_path: category.path,
          path: newPath,
          moved_categories: moved.length,
          taxonomy_version: taxonomyVersion,
        },
      });
      const updated = await this.require(actor.workspaceId, category.id, tx);
      return { category: await this.withAliases(updated), taxonomyVersion };
    });
  }

  /** Archives a category and its descendants; they stay readable but are hidden by default. */
  async archive(actor: ActorContext, categoryId: CategoryId): Promise<TaxonomyResult> {
    const now = this.clock.now();
    return this.o.uow.run(async (tx) => {
      await this.o.categories.lock(tx, actor.workspaceId);
      const category = await this.require(actor.workspaceId, categoryId, tx);
      // An already-archived category may still have an active descendant, if one
      // was created under it in the window this lock now closes. Archiving again
      // is how an operator repairs that, so it is not an early return.
      const archived = await this.o.categories.setSubtreeStatus(
        tx,
        actor.workspaceId,
        category.path,
        'archived',
        now,
      );
      if (archived.length === 0) {
        return {
          category: await this.withAliases(category),
          taxonomyVersion: await this.o.versions.current(actor.workspaceId, tx),
        };
      }
      const taxonomyVersion = await this.o.versions.bump(tx, actor.workspaceId, now);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'category.archived',
        objectType: 'category',
        objectId: category.id,
        categoryIds: archived,
        metadata: {
          path: category.path,
          archived_categories: archived.length,
          taxonomy_version: taxonomyVersion,
        },
      });
      const updated = await this.require(actor.workspaceId, category.id, tx);
      return { category: await this.withAliases(updated), taxonomyVersion };
    });
  }

  private async withAliases(category: CategoryRecord): Promise<CategoryWithAliases> {
    const aliases = await this.o.aliases.listForWorkspace(category.workspaceId);
    return {
      ...category,
      aliases: aliases.filter((a) => a.categoryId === category.id).map((a) => a.alias),
    };
  }

  private async writeAliases(
    tx: Tx,
    category: CategoryRecord,
    aliases: string[],
    now: Date,
  ): Promise<void> {
    await this.o.aliases.replaceForCategory(
      tx,
      category.id,
      aliases.map<AliasRecord>((alias) => ({
        id: newId('alias'),
        categoryId: category.id,
        workspaceId: category.workspaceId,
        alias,
        normalisedAlias: normaliseAlias(alias),
        createdAt: now,
      })),
    );
  }

  /** A generated path is still checked, and a failure is a refusal, not a crash. */
  private parsePath(value: string): string {
    const parsed = CategoryPath.safeParse(value);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', `invalid category path: ${value}`);
    }
    return parsed.data;
  }

  /** The path this category would have under its current parent with a new slug. */
  private pathWithSlug(category: CategoryRecord, slug: string): string {
    // A root category's path is its slug, so there is no parent prefix to keep.
    const cut = category.path.length - category.slug.length - 1;
    const parentPath = cut > 0 ? category.path.slice(0, cut) : '';
    return this.parsePath(parentPath ? `${parentPath}/${slug}` : slug);
  }

  private parseName(value: string): string {
    const parsed = CategoryName.safeParse(value);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'category name is required');
    return parsed.data;
  }

  private parseSlug(value: string): string {
    const parsed = CategorySlug.safeParse(value);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', `invalid slug: ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
  }

  private parseGuidance(value: string[] | undefined): string[] {
    if (value === undefined) return [];
    const parsed = Guidance.safeParse(value);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'invalid guidance entries');
    return parsed.data;
  }

  private async parseAliases(
    workspaceId: WorkspaceId,
    values: string[],
    ownerId: CategoryId | null,
    tx?: Tx,
  ): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const parsed = CategoryAlias.safeParse(value);
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'invalid alias');
      const normalised = normaliseAlias(parsed.data);
      if (seen.has(normalised)) continue;
      const existing = await this.o.aliases.findByNormalised(workspaceId, normalised, tx);
      if (existing && existing.categoryId !== ownerId) {
        throw new DomainError('CATEGORY_CONFLICT', `the alias "${parsed.data}" is already in use`, {
          objectIds: { category_id: existing.categoryId },
        });
      }
      seen.add(normalised);
      out.push(parsed.data);
    }
    return out;
  }

  private async require(
    workspaceId: WorkspaceId,
    categoryId: CategoryId,
    tx?: Tx,
  ): Promise<CategoryRecord> {
    const category = await this.o.categories.findById(workspaceId, categoryId, tx);
    if (!category) throw new DomainError('NOT_FOUND', 'category not found');
    return category;
  }

  private async resolveParent(
    workspaceId: WorkspaceId,
    parentPath: string | undefined,
    tx?: Tx,
  ): Promise<CategoryRecord | null> {
    if (parentPath === undefined) return null;
    const parsed = CategoryPath.safeParse(parentPath);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'invalid parent path');
    const parent = await this.o.categories.findByPath(workspaceId, parsed.data, tx);
    if (!parent) throw new DomainError('NOT_FOUND', `no category at ${parsed.data}`);
    return parent;
  }
}

/** Readable and unique enough when a name yields no slug of its own. */
function fallbackSlug(categoryId: string): string {
  return `category-${categoryId.slice(-8).toLowerCase()}`;
}
