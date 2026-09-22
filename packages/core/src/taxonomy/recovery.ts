import type { CategoryId, WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { OperationRecord } from '../operations/repository.ts';
import type { KnowledgeItemId } from '@knoverge/contracts';

import { planRelocation, type ItemFileLookup } from './relocate.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { GitStore } from '../ports/git-store.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import { newId } from '../ids.ts';
import type {
  AliasRecord,
  AliasRepository,
  CategoryRecord,
  CategoryRepository,
  TaxonomyVersionRepository,
} from './repository.ts';
import type { TaxonomyChangeKind } from './service.ts';

/** `Knoverge-Category: cat_... <kind>` */
const CATEGORY = /^(cat_[0-9A-HJKMNP-TV-Z]{26})\s+(create|update|move|archive|restore|merge)$/;

/** One category as `taxonomy.yaml` carries it. */
export interface TaxonomyFileCategory {
  path: string;
  slug: string;
  name: string;
  status: string;
  description: string | null;
  aliases: string[];
  inclusionGuidance: string[];
  exclusionGuidance: string[];
}

export interface TaxonomyRecoveryOptions {
  uow: UnitOfWork;
  categories: CategoryRepository;
  aliases: AliasRepository;
  versions: TaxonomyVersionRepository;
  ledger: EventLedger;
  git: GitStore;
  taxonomyPath: string;
  parseTaxonomy: (text: string) => { version: number; categories: TaxonomyFileCategory[] };
  /**
   * The knowledge index, because a path change took files with it and the
   * commit that moved them landed while PostgreSQL did not (ADR 0016).
   */
  items: ItemFileLookup & {
    update(
      tx: Tx,
      id: KnowledgeItemId,
      patch: { slug?: string; markdownPath?: string; updatedAt?: Date },
    ): Promise<void>;
  };
  uniqueSlug: (wanted: string, taken: ReadonlySet<string>) => string;
  clock?: Clock;
}

/**
 * Finishes the PostgreSQL side of a taxonomy change that reached Git and no
 * further.
 *
 * The file at the commit carries the whole tree, which is almost enough: what
 * it cannot carry is identity, because a path is not an id and a rename makes
 * that obvious. `Knoverge-Category` supplies the missing piece — which
 * category the commit acted on and what happened to it — and the operation row
 * supplies the path it ended at and the request context rule 3 wants.
 *
 * Nothing here decides anything. The commit decided; this writes it down.
 */
export class TaxonomyRecovery {
  private readonly o: TaxonomyRecoveryOptions;
  private readonly clock: Clock;

  constructor(options: TaxonomyRecoveryOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  handles(operation: OperationRecord): boolean {
    return operation.operationType === 'taxonomy';
  }

  async complete(operation: OperationRecord): Promise<boolean> {
    const commitHash = operation.gitCommitHash;
    if (!commitHash || !this.handles(operation)) return false;

    const trailers = await this.o.git.trailersOf(operation.workspaceId, commitHash);
    const match = CATEGORY.exec(trailers.find(([name]) => name === 'Knoverge-Category')?.[1] ?? '');
    const versionTrailer = trailers.find(([name]) => name === 'Knoverge-Taxonomy-Version')?.[1];
    // A commit from before these trailers existed cannot be rebuilt, and
    // guessing would be worse than leaving it for an operator.
    if (!match || !versionTrailer) return false;
    const categoryId = match[1] as CategoryId;
    const kind = match[2] as TaxonomyChangeKind;
    // Which category a merge folded this one into. The file records that the
    // closed category was merged and never says where its contents went.
    const intoId = trailers.find(([name]) => name === 'Knoverge-Category-Into')?.[1] as
      CategoryId | undefined;
    if (kind === 'merge' && !intoId) return false;
    const version = Number(versionTrailer);
    if (!Number.isSafeInteger(version) || version < 1) return false;

    // Already done: recovery runs at every startup.
    const latest = await this.o.versions.latest(operation.workspaceId);
    if (latest && latest.version >= version) return true;
    // A gap means an earlier operation is still unresolved, and writing this
    // one would build history on top of a hole.
    if ((latest?.version ?? 0) !== version - 1) return false;

    const file = await this.o.git.readAt(operation.workspaceId, commitHash, this.o.taxonomyPath);
    if (file === null) return false;
    const parsed = this.o.parseTaxonomy(file);
    if (parsed.version !== version) return false;

    const path = operation.objectIds['path'];
    if (typeof path !== 'string') return false;
    const entry = parsed.categories.find((c) => c.path === path);
    // Archive and restore leave the path alone; create, update and move put
    // the category at the path the operation recorded. Either way the file
    // must have it, or the commit is not the one this operation made.
    if (!entry) return false;

    const now = this.clock.now();
    const actor = this.actorOf(operation);
    await this.o.uow.run(async (tx) => {
      const existing = await this.o.categories.findById(operation.workspaceId, categoryId, tx);
      // The files are already where the commit put them; what was lost is the
      // index saying so. The plan touches no repository and is worked out from
      // the same unchanged rows, so asking for it again gives the same answer
      // the writer got.
      const moves =
        existing && kind !== 'create'
          ? await planRelocation(
              { items: this.o.items, uniqueSlug: this.o.uniqueSlug },
              operation.workspaceId,
              kind === 'merge'
                ? [
                    {
                      from: existing.path,
                      to: (await this.targetPath(operation, intoId, tx)) ?? existing.path,
                    },
                  ]
                : [{ from: existing.path, to: entry.path }],
            )
          : [];
      for (const move of moves) {
        await this.o.items.update(tx, move.id, {
          slug: move.slug,
          markdownPath: move.to,
          updatedAt: now,
        });
      }

      if (kind === 'create') {
        if (!existing) await this.insert(tx, operation, categoryId, entry, now);
      } else if (kind === 'merge') {
        if (!existing) throw new Error(`category ${categoryId} is missing`);
        const target = await this.o.categories.findById(
          operation.workspaceId,
          intoId as CategoryId,
          tx,
        );
        if (!target) throw new Error(`category ${intoId} is missing`);
        await this.mergeInto(tx, operation.workspaceId, existing, target, now);
        // Both sides of a merge change their aliases, and the closed one's
        // pass to the survivor. Writing only the category the trailer names
        // would leave the survivor without what it inherited.
        const targetEntry = parsed.categories.find((c) => c.path === target.path);
        if (!targetEntry) throw new Error(`${target.path} is missing from the committed taxonomy`);
        await this.writeAliases(tx, operation.workspaceId, categoryId, entry.aliases, now);
        await this.writeAliases(tx, operation.workspaceId, target.id, targetEntry.aliases, now);
      } else {
        if (!existing) throw new Error(`category ${categoryId} is missing`);
        await this.apply(tx, operation.workspaceId, existing, entry, kind, now);
      }
      if (kind !== 'merge') {
        await this.writeAliases(tx, operation.workspaceId, categoryId, entry.aliases, now);
      }
      await this.o.versions.bump(tx, operation.workspaceId, now, version, commitHash);
      await this.o.ledger.append(tx, operation.workspaceId, actor, {
        eventType: eventFor(kind),
        objectType: 'category',
        objectId: categoryId,
        categoryIds: [categoryId],
        metadata: {
          path: entry.path,
          taxonomy_version: version,
          git_commit: commitHash,
          recovered: true,
        },
      });
    });
    return true;
  }

  /**
   * Replays a merge, from a commit that landed before PostgreSQL was written.
   *
   * Every statement is one that can be run twice: the items still pointing at
   * the closed category are exactly the ones the lost transaction had not
   * moved, and a descendant already under the survivor's path no longer
   * matches the old prefix.
   */
  private async mergeInto(
    tx: Tx,
    workspaceId: WorkspaceId,
    source: CategoryRecord,
    target: CategoryRecord,
    now: Date,
  ): Promise<void> {
    await this.o.categories.recategoriseItems(tx, source.id, target.id);
    await this.o.categories.reparentChildren(tx, workspaceId, source.id, target.id, now);
    await this.o.categories.rewriteDescendantPaths(tx, workspaceId, source.path, target.path, now);
    await this.o.categories.update(tx, source.id, {
      status: 'merged',
      mergedIntoCategoryId: target.id,
      updatedAt: now,
    });
  }

  /** Where a merge sent its contents, for the relocation it also performed. */
  private async targetPath(
    operation: OperationRecord,
    intoId: CategoryId | undefined,
    tx: Tx,
  ): Promise<string | null> {
    if (!intoId) return null;
    const target = await this.o.categories.findById(operation.workspaceId, intoId, tx);
    return target?.path ?? null;
  }

  private async insert(
    tx: Tx,
    operation: OperationRecord,
    id: CategoryId,
    entry: TaxonomyFileCategory,
    now: Date,
  ): Promise<void> {
    const workspaceId = operation.workspaceId;
    const parentPath = entry.path.includes('/')
      ? entry.path.slice(0, entry.path.lastIndexOf('/'))
      : null;
    const parent = parentPath
      ? await this.o.categories.findByPath(workspaceId, parentPath, tx)
      : null;
    if (parentPath && !parent) throw new Error(`parent ${parentPath} is missing`);
    await this.o.categories.insert(tx, {
      id,
      workspaceId,
      parentId: parent?.id ?? null,
      slug: entry.slug,
      path: entry.path,
      name: entry.name,
      description: entry.description,
      status: entry.status as CategoryRecord['status'],
      inclusionGuidance: entry.inclusionGuidance,
      exclusionGuidance: entry.exclusionGuidance,
      mergedIntoCategoryId: null,
      // The actor the operation row kept: the request that made this commit is
      // the one that created the category, even though it never got to say so.
      createdByActorId: operation.actorId,
      approvedByActorId: null,
      createdAt: now,
      updatedAt: now,
    } as CategoryRecord);
  }

  private async apply(
    tx: Tx,
    workspaceId: WorkspaceId,
    existing: CategoryRecord,
    entry: TaxonomyFileCategory,
    kind: TaxonomyChangeKind,
    now: Date,
  ): Promise<void> {
    if (kind === 'archive' || kind === 'restore') {
      await this.o.categories.setSubtreeStatus(
        tx,
        workspaceId,
        existing.path,
        kind === 'archive'
          ? { from: 'active', to: 'archived' }
          : { from: 'archived', to: 'active' },
        now,
      );
      return;
    }
    if (existing.path !== entry.path) {
      // Descendants first, then the category itself in one statement: the
      // check that a path ends in its own slug holds at every point.
      await this.o.categories.rewriteDescendantPaths(
        tx,
        workspaceId,
        existing.path,
        entry.path,
        now,
      );
    }
    const parentPath = entry.path.includes('/')
      ? entry.path.slice(0, entry.path.lastIndexOf('/'))
      : null;
    const parent = parentPath
      ? await this.o.categories.findByPath(workspaceId, parentPath, tx)
      : null;
    await this.o.categories.update(tx, existing.id, {
      slug: entry.slug,
      path: entry.path,
      parentId: parent?.id ?? null,
      name: entry.name,
      description: entry.description,
      inclusionGuidance: entry.inclusionGuidance,
      exclusionGuidance: entry.exclusionGuidance,
      updatedAt: now,
    });
  }

  private async writeAliases(
    tx: Tx,
    workspaceId: WorkspaceId,
    categoryId: CategoryId,
    aliases: readonly string[],
    now: Date,
  ): Promise<void> {
    await this.o.aliases.replaceForCategory(
      tx,
      categoryId,
      aliases.map<AliasRecord>((alias) => ({
        id: newId('alias'),
        categoryId,
        workspaceId,
        alias,
        normalisedAlias: alias.trim().toLowerCase(),
        createdAt: now,
      })),
    );
  }

  /** The request context the commit never carried, from the row that kept it. */
  private actorOf(operation: OperationRecord): ActorContext {
    return {
      workspaceId: operation.workspaceId,
      actorId: operation.actorId,
      actorType: operation.agentId ? 'agent' : 'human',
      requestId: operation.requestId,
      ...(operation.agentId ? { agentId: operation.agentId } : {}),
      ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
      ...(operation.client ? { client: operation.client } : {}),
      ...(operation.provider ? { provider: operation.provider } : {}),
      ...(operation.model ? { model: operation.model } : {}),
    } as ActorContext;
  }
}

function eventFor(
  kind: TaxonomyChangeKind,
):
  | 'category.created'
  | 'category.updated'
  | 'category.moved'
  | 'category.archived'
  | 'category.restored'
  | 'category.merged' {
  switch (kind) {
    case 'create':
      return 'category.created';
    case 'move':
      return 'category.moved';
    case 'archive':
      return 'category.archived';
    case 'restore':
      return 'category.restored';
    case 'merge':
      return 'category.merged';
    default:
      return 'category.updated';
  }
}
