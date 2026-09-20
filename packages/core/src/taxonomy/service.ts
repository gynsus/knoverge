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
import {
  sortedAliases,
  subtreeIds,
  withCategory,
  withMove,
  withSubtreeStatus,
  withUpdate,
} from './projection.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { GitStore } from '../ports/git-store.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type { CrossStoreWriter } from '../operations/service.ts';
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
  actors: ActorLookup;
  ledger: EventLedger;
  /** Writes the change to the repository before PostgreSQL sees it. */
  crossStore: CrossStoreWriter;
  git: GitStore;
  /** Renders the whole tree, which is what `taxonomy.yaml` holds. */
  renderTaxonomy: (categories: readonly TaxonomyFileEntry[], version: number, at: Date) => string;
  /** Where the file lives in the repository. */
  taxonomyPath: string;
  workspaces: WorkspaceLookup;
  clock?: Clock;
}

/** Enough of an actor to attribute a commit to it. */
export interface ActorLookup {
  findById(
    workspaceId: WorkspaceId,
    actorId: ActorContext['actorId'],
  ): Promise<{ displayName: string } | null>;
}

/** Enough of a workspace to name its repository and its README. */
export interface WorkspaceLookup {
  findById(workspaceId: WorkspaceId): Promise<{ id: WorkspaceId; name: string } | null>;
}

/** One category as the repository records it. */
export interface TaxonomyFileEntry {
  path: string;
  slug: string;
  name: string;
  status: string;
  description: string | null;
  aliases: string[];
  inclusionGuidance: string[];
  exclusionGuidance: string[];
}

/**
 * A taxonomy change, ready to be written.
 *
 * Validation happens before anything is written and under the workspace lock,
 * so the tree it produces is the tree the repository file is rendered from.
 * The file is committed before PostgreSQL is touched, which is why the result
 * has to be computed rather than read back.
 */
interface PlannedChange {
  subject: string;
  objectIds: Record<string, unknown>;
  /** The whole tree as it will be once this is applied. */
  categories: CategoryRecord[];
  /** Aliases of every category, by category id, as they will be. */
  aliases: Map<string, string[]>;
  apply: (tx: Tx, version: number, commitHash: string) => Promise<TaxonomyResult>;
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

    return this.change(actor, async () => {
      const tree = await this.tree(actor.workspaceId);
      const parent = this.resolveParentIn(tree.categories, input.parentPath);
      if (parent && parent.status !== 'active') {
        throw new DomainError('CATEGORY_CONFLICT', 'the parent category is not active');
      }
      const path = this.parsePath(parent ? `${parent.path}/${slug}` : slug);
      if (path.split('/').length > MAX_CATEGORY_DEPTH) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `categories may not nest deeper than ${MAX_CATEGORY_DEPTH}`,
        );
      }
      if (tree.categories.some((c) => c.path === path)) {
        throw new DomainError('CATEGORY_CONFLICT', `a category already exists at ${path}`, {
          objectIds: { path },
        });
      }
      const aliases = await this.parseAliases(actor.workspaceId, input.aliases ?? [], null);
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
      return {
        subject: `taxonomy: create ${path}`,
        objectIds: { category: id, path },
        categories: withCategory(tree.categories, category),
        aliases: new Map(tree.aliases).set(id, aliases),
        apply: async (tx, version, commitHash) => {
          await this.o.categories.insert(tx, category);
          await this.writeAliases(tx, category, aliases, now);
          await this.o.versions.bump(tx, actor.workspaceId, now, version, commitHash);
          await this.o.ledger.append(tx, actor.workspaceId, actor, {
            eventType: 'category.created',
            objectType: 'category',
            objectId: category.id,
            categoryIds: [category.id],
            metadata: {
              path,
              taxonomy_version: version,
              git_commit: commitHash,
              ...(parent ? { parent_id: parent.id } : {}),
            },
          });
          return { category: { ...category, aliases }, taxonomyVersion: version };
        },
      };
    });
  }

  async update(actor: ActorContext, input: UpdateCategoryInput): Promise<TaxonomyResult> {
    const now = this.clock.now();
    return this.change(actor, async () => {
      const tree = await this.tree(actor.workspaceId);
      const category = this.requireIn(tree.categories, input.categoryId);
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
          if (tree.categories.some((c) => c.path === newPath)) {
            throw new DomainError('CATEGORY_CONFLICT', `a category already exists at ${newPath}`);
          }
        }
      }
      const aliases =
        input.aliases === undefined
          ? undefined
          : await this.parseAliases(actor.workspaceId, input.aliases, category.id);
      if (Object.keys(patch).length === 0 && aliases === undefined) {
        throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
      }

      patch.updatedAt = now;
      const applied = newPath ? { ...patch, path: newPath } : patch;
      const nextAliases = new Map(tree.aliases);
      if (aliases !== undefined) nextAliases.set(category.id, aliases);
      return {
        subject: `taxonomy: update ${newPath ?? category.path}`,
        objectIds: { category: category.id, path: newPath ?? category.path },
        categories: withUpdate(
          tree.categories,
          category.id,
          applied,
          newPath ? { from: category.path, to: newPath } : undefined,
        ),
        aliases: nextAliases,
        apply: async (tx, version, commitHash) => {
          if (newPath) {
            // Descendants first, then this category's slug and path in one
            // statement: the database checks that a path ends in its own slug,
            // so writing the slug and the path separately would break it in
            // between.
            await this.o.categories.rewriteDescendantPaths(
              tx,
              actor.workspaceId,
              category.path,
              newPath,
              now,
            );
          }
          await this.o.categories.update(tx, category.id, applied);
          if (aliases !== undefined) await this.writeAliases(tx, category, aliases, now);
          await this.o.versions.bump(tx, actor.workspaceId, now, version, commitHash);
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
              taxonomy_version: version,
              git_commit: commitHash,
              ...(newPath ? { path: newPath, previous_path: category.path } : {}),
            },
          });
          const updated = await this.require(actor.workspaceId, category.id, tx);
          return {
            category: { ...updated, aliases: aliases ?? tree.aliases.get(category.id) ?? [] },
            taxonomyVersion: version,
          };
        },
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
    return this.change(actor, async () => {
      const tree = await this.tree(actor.workspaceId);
      const category = this.requireIn(tree.categories, categoryId);
      const parent = newParentId === null ? null : this.requireIn(tree.categories, newParentId);
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
        throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
      }
      const newPath = parent ? `${parent.path}/${category.slug}` : category.slug;
      const subtree = tree.categories.filter(
        (c) => c.path === category.path || c.path.startsWith(`${category.path}/`),
      );
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
      if (tree.categories.some((c) => c.path === newPath)) {
        throw new DomainError('CATEGORY_CONFLICT', `a category already exists at ${newPath}`);
      }

      const moved = subtreeIds(tree.categories, category.path);
      return {
        subject: `taxonomy: move ${category.path} to ${newPath}`,
        objectIds: { category: category.id, path: newPath, previous_path: category.path },
        categories: withMove(tree.categories, category.id, parent?.id ?? null, {
          from: category.path,
          to: newPath,
        }),
        aliases: tree.aliases,
        apply: async (tx, version, commitHash) => {
          await this.o.categories.update(tx, category.id, {
            parentId: parent?.id ?? null,
            updatedAt: now,
          });
          await this.o.categories.rewritePaths(tx, actor.workspaceId, category.path, newPath, now);
          await this.o.versions.bump(tx, actor.workspaceId, now, version, commitHash);
          await this.o.ledger.append(tx, actor.workspaceId, actor, {
            eventType: 'category.moved',
            objectType: 'category',
            objectId: category.id,
            categoryIds: moved,
            metadata: {
              previous_path: category.path,
              path: newPath,
              moved_categories: moved.length,
              taxonomy_version: version,
              git_commit: commitHash,
            },
          });
          const updated = await this.require(actor.workspaceId, category.id, tx);
          return { category: await this.withAliases(updated, tx), taxonomyVersion: version };
        },
      };
    });
  }

  /** Archives a category and its descendants; they stay readable but are hidden by default. */
  async archive(actor: ActorContext, categoryId: CategoryId): Promise<TaxonomyResult> {
    const now = this.clock.now();
    return this.change(actor, async () => {
      const tree = await this.tree(actor.workspaceId);
      const category = this.requireIn(tree.categories, categoryId);
      // An already-archived category may still have an active descendant, if
      // one was created under it in a window a lock has since closed.
      // Archiving again is how an operator repairs that.
      const archived = subtreeIds(tree.categories, category.path, (c) => c.status === 'active');
      if (archived.length === 0) {
        throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
      }
      return {
        subject: `taxonomy: archive ${category.path}`,
        objectIds: { category: category.id, path: category.path },
        categories: withSubtreeStatus(tree.categories, category.path, 'active', 'archived'),
        aliases: tree.aliases,
        apply: async (tx, version, commitHash) => {
          await this.o.categories.setSubtreeStatus(
            tx,
            actor.workspaceId,
            category.path,
            { from: 'active', to: 'archived' },
            now,
          );
          await this.o.versions.bump(tx, actor.workspaceId, now, version, commitHash);
          await this.o.ledger.append(tx, actor.workspaceId, actor, {
            eventType: 'category.archived',
            objectType: 'category',
            objectId: category.id,
            categoryIds: archived,
            metadata: {
              path: category.path,
              archived_categories: archived.length,
              taxonomy_version: version,
              git_commit: commitHash,
            },
          });
          const updated = await this.require(actor.workspaceId, category.id, tx);
          return { category: await this.withAliases(updated, tx), taxonomyVersion: version };
        },
      };
    });
  }

  /** Brings an archived category and its descendants back into the active tree. */
  async restore(actor: ActorContext, categoryId: CategoryId): Promise<TaxonomyResult> {
    const now = this.clock.now();
    return this.change(actor, async () => {
      const tree = await this.tree(actor.workspaceId);
      const category = this.requireIn(tree.categories, categoryId);
      const parent = category.parentId
        ? tree.categories.find((c) => c.id === category.parentId)
        : null;
      if (parent && parent.status !== 'active') {
        // An active category under an archived parent is the inconsistency the
        // rest of this service exists to prevent.
        throw new DomainError(
          'CATEGORY_CONFLICT',
          'the parent category is archived; restore it first',
          { objectIds: { category_id: parent.id } },
        );
      }
      const restored = subtreeIds(tree.categories, category.path, (c) => c.status === 'archived');
      if (restored.length === 0) {
        throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
      }
      return {
        subject: `taxonomy: restore ${category.path}`,
        objectIds: { category: category.id, path: category.path },
        categories: withSubtreeStatus(tree.categories, category.path, 'archived', 'active'),
        aliases: tree.aliases,
        apply: async (tx, version, commitHash) => {
          await this.o.categories.setSubtreeStatus(
            tx,
            actor.workspaceId,
            category.path,
            { from: 'archived', to: 'active' },
            now,
          );
          await this.o.versions.bump(tx, actor.workspaceId, now, version, commitHash);
          await this.o.ledger.append(tx, actor.workspaceId, actor, {
            eventType: 'category.restored',
            objectType: 'category',
            objectId: category.id,
            categoryIds: restored,
            metadata: {
              path: category.path,
              restored_categories: restored.length,
              taxonomy_version: version,
              git_commit: commitHash,
            },
          });
          const updated = await this.require(actor.workspaceId, category.id, tx);
          return { category: await this.withAliases(updated, tx), taxonomyVersion: version };
        },
      };
    });
  }

  /**
   * The whole tree and its aliases, read once per change.
   *
   * The workspace lock is held, so nothing can change underneath this and the
   * snapshot is the state the change is validated against and rendered from.
   */
  private async tree(
    workspaceId: WorkspaceId,
  ): Promise<{ categories: CategoryRecord[]; aliases: Map<string, string[]> }> {
    const categories = await this.o.categories.list(workspaceId, { includeArchived: true });
    const aliases = new Map<string, string[]>();
    for (const alias of await this.o.aliases.listForWorkspace(workspaceId)) {
      aliases.set(alias.categoryId, [...(aliases.get(alias.categoryId) ?? []), alias.alias]);
    }
    return { categories, aliases };
  }

  private requireIn(categories: readonly CategoryRecord[], categoryId: CategoryId): CategoryRecord {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) throw new DomainError('NOT_FOUND', 'category not found');
    return category;
  }

  private resolveParentIn(
    categories: readonly CategoryRecord[],
    parentPath: string | undefined,
  ): CategoryRecord | null {
    if (parentPath === undefined) return null;
    const parsed = CategoryPath.safeParse(parentPath);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'invalid parent path');
    const parent = categories.find((c) => c.path === parsed.data);
    if (!parent) throw new DomainError('NOT_FOUND', `no category at ${parsed.data}`);
    return parent;
  }

  /**
   * Runs a taxonomy change as one write across the repository and PostgreSQL.
   *
   * The order is fixed by ARCHITECTURE.md section 4 and the workspace lock is
   * held throughout, so validation can read through the pool: no other writer
   * can be inside this workspace at the same time.
   */
  private async change(
    actor: ActorContext,
    plan: () => Promise<PlannedChange>,
  ): Promise<TaxonomyResult> {
    let planned: PlannedChange | undefined;
    let version = 0;
    return this.o.crossStore.run<TaxonomyResult>(actor, {
      type: 'taxonomy',
      objectIds: {},
      commit: async (operation) => {
        planned = await plan();
        const workspace = await this.o.workspaces.findById(actor.workspaceId);
        if (!workspace) throw new DomainError('NOT_FOUND', 'workspace not found');
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.o.git.ensureRepository(actor.workspaceId, workspace.name, author, now);
        const latest = await this.o.versions.latest(actor.workspaceId);
        // PostgreSQL records the commit that wrote each version, so a
        // repository that does not contain the newest one is not the
        // repository this workspace's history belongs to: it was lost,
        // replaced, or is somebody else's. Writing into it would build new
        // history on top of a hole and call the result canonical.
        //
        // A version with no commit is from before this milestone and is not a
        // mismatch; the first write after an upgrade simply starts the
        // repository.
        if (
          latest?.gitCommitHash &&
          !(await this.o.git.hasCommit(actor.workspaceId, latest.gitCommitHash))
        ) {
          throw new DomainError(
            'INTERNAL_ERROR',
            'the workspace repository does not contain the commit this workspace was last written with; restore it from a backup before writing again',
            { objectIds: { workspace_id: actor.workspaceId, commit: latest.gitCommitHash } },
          );
        }

        // The lock excludes every other writer in this workspace, so the next
        // number cannot be taken twice and does not need reserving first.
        version = (latest?.version ?? 0) + 1;
        const entries = planned.categories
          .map<TaxonomyFileEntry>((category) => ({
            path: category.path,
            slug: category.slug,
            name: category.name,
            status: category.status,
            description: category.description,
            aliases: sortedAliases(planned?.aliases.get(category.id) ?? []),
            inclusionGuidance: category.inclusionGuidance,
            exclusionGuidance: category.exclusionGuidance,
          }))
          .sort((a, b) => a.path.localeCompare(b.path));
        await this.o.git.write(actor.workspaceId, [
          { path: this.o.taxonomyPath, content: this.o.renderTaxonomy(entries, version, now) },
        ]);
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: [this.o.taxonomyPath],
          subject: planned.subject,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            ['Knoverge-Taxonomy-Version', String(version)],
          ],
          author,
          at: now,
        });
        if (commitHash === null) {
          // The tree is already what this change would make it. Committing
          // nothing would leave an operation pointing at no commit.
          throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
        }
        return { commitHash, taxonomyVersion: version, objectIds: planned.objectIds };
      },
      record: async (tx, operation) => {
        if (!planned) throw new DomainError('INTERNAL_ERROR', 'the change was never planned');
        return planned.apply(tx, version, operation.gitCommitHash as string);
      },
    });
  }

  /** The commit author: the actor, so the log points back at who did it. */
  private async authorOf(actor: ActorContext): Promise<{ name: string; email: string }> {
    const record = await this.o.actors.findById(actor.workspaceId, actor.actorId);
    return {
      name: record?.displayName ?? 'Knoverge',
      email: `${actor.actorId}@knoverge.local`,
    };
  }

  private async withAliases(category: CategoryRecord, tx?: Tx): Promise<CategoryWithAliases> {
    const aliases = await this.o.aliases.listForWorkspace(category.workspaceId, tx);
    return {
      ...category,
      aliases: sortedAliases(
        aliases.filter((a) => a.categoryId === category.id).map((a) => a.alias),
      ),
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
