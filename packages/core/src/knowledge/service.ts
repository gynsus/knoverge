import {
  CategorySlug,
  type ActorId,
  type Frontmatter,
  type ItemType,
  type KnowledgeItemId,
  type RevisionId,
  type WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { CrossStoreWriter } from '../operations/service.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { CommitAuthor, GitStore } from '../ports/git-store.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type {
  CategoryRecord,
  CategoryRepository,
  TaxonomyVersionRepository,
} from '../taxonomy/repository.ts';
import type {
  ItemCategoryRecord,
  ListItemsOptions,
  KnowledgeItemRecord,
  KnowledgeRepository,
  RevisionRecord,
  RevisionRepository,
} from './repository.ts';

/** Where an item with no category lives, so every item still has a path. */
export const UNCATEGORISED_DIRECTORY = 'knowledge/_uncategorised';

/** The knowledge itself. A document is meant to be long; this is the ceiling. */
export const MAX_BODY_BYTES = 200_000;

export interface ActorLookup {
  findById(
    workspaceId: WorkspaceId,
    actorId: ActorId,
  ): Promise<{ id: ActorId; displayName: string | null } | null>;
}

export interface WorkspaceLookup {
  findById(workspaceId: WorkspaceId): Promise<{ id: WorkspaceId; name: string } | null>;
}

export interface KnowledgeServiceOptions {
  uow: UnitOfWork;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  categories: CategoryRepository;
  versions: TaxonomyVersionRepository;
  actors: ActorLookup;
  workspaces: WorkspaceLookup;
  ledger: EventLedger;
  crossStore: CrossStoreWriter;
  git: GitStore;
  /** Turns a title into a slug, and content into its hash. */
  slugifyTitle: (title: string) => string;
  uniqueSlug: (slug: string, taken: ReadonlySet<string>) => string;
  renderItem: (item: { frontmatter: Frontmatter; body: string }) => string;
  parseItem: (text: string) => { frontmatter: Frontmatter; body: string };
  contentHash: (title: string, body: string) => string;
  frontmatterHash: (yaml: string) => string;
  clock?: Clock;
}

export interface CreateItemInput {
  title: string;
  body: string;
  type: ItemType;
  language?: string | undefined;
  /** Slug paths. The first is primary and decides where the file lives. */
  categories?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  slug?: string | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  observedAt?: string | null | undefined;
  external?: { source_system: string; external_key: string } | undefined;
}

/** An item as a list shows it: everything but the knowledge itself. */
export interface ItemSummary {
  item: KnowledgeItemRecord;
  title: string;
  categories: string[];
  tags: string[];
}

export interface ItemResult {
  item: KnowledgeItemRecord;
  revision: RevisionRecord;
  categories: string[];
  tags: string[];
  body: string;
}

/**
 * Knowledge items: the Markdown file in Git is canonical, PostgreSQL indexes
 * it, and every change to either is one operation through the cross-store
 * primitive (ARCHITECTURE.md section 4).
 *
 * Direct writes here are for people. An agent proposes instead: rule 14 says
 * an agent write requires review unless a policy rule allows it directly, and
 * the proposal machinery that makes that decision arrives in Milestone 3. The
 * adapter refuses an agent rather than letting one through unreviewed.
 */
export class KnowledgeService {
  private readonly o: KnowledgeServiceOptions;
  private readonly clock: Clock;

  constructor(options: KnowledgeServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async create(actor: ActorContext, input: CreateItemInput): Promise<ItemResult> {
    const body = input.body.trim();
    if (body === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a body');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new DomainError('VALIDATION_ERROR', `the body may not exceed ${MAX_BODY_BYTES} bytes`);
    }
    const title = input.title.trim();
    if (title === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a title');

    const itemId = newId('kn') as KnowledgeItemId;
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedItem | undefined;

    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'create',
      objectIds: { knowledge_item: itemId },
      commit: async (operation) => {
        const workspace = await this.o.workspaces.findById(actor.workspaceId);
        if (!workspace) throw new DomainError('NOT_FOUND', 'workspace not found');
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.o.git.ensureRepository(actor.workspaceId, workspace.name, author, now);
        await this.assertRepositoryIsOurs(actor.workspaceId);

        // Archived ones included, so an item aimed at an archived category is
        // told that rather than told the category does not exist.
        const tree = await this.o.categories.list(actor.workspaceId, { includeArchived: true });
        const chosen = this.resolveCategories(tree, input.categories ?? []);
        const directory = chosen[0] ? `knowledge/${chosen[0].path}` : UNCATEGORISED_DIRECTORY;
        const taken = await this.o.items.slugsInDirectory(actor.workspaceId, directory);
        const wanted = input.slug ?? this.o.slugifyTitle(title);
        const slug = this.parseSlug(this.o.uniqueSlug(wanted, new Set(taken)));
        const markdownPath = `${directory}/${slug}.md`;

        const language = input.language ?? 'en';
        const frontmatter: Frontmatter = {
          id: itemId,
          title,
          type: input.type,
          status: 'active',
          language,
          categories: chosen.map((c) => c.path),
          tags: [...new Set(input.tags ?? [])].sort(),
          review: actor.actorType === 'human' ? 'human_reviewed' : 'unreviewed',
          evidence: 'none',
          disputed: false,
          valid_from: input.validFrom ?? null,
          valid_until: input.validUntil ?? null,
          observed_at: input.observedAt ?? null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          sources: [],
          relations: [],
          ...(input.external ? { external: input.external } : {}),
        } as Frontmatter;

        const rendered = this.o.renderItem({ frontmatter, body });
        await this.o.git.write(actor.workspaceId, [{ path: markdownPath, content: rendered }]);
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: [markdownPath],
          subject: `create(${input.type}): ${title}`,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            // What recovery needs to rebuild the PostgreSQL side from the
            // commit alone: which item, which revision, and what happened.
            ['Knoverge-Change', `${itemId}@${revisionId} create`],
          ],
          author,
          at: now,
        });
        if (commitHash === null) {
          throw new DomainError('INTERNAL_ERROR', 'the item was written but produced no commit');
        }
        planned = { frontmatter, body, slug, markdownPath, chosen, rendered, now, commitHash };
        return { commitHash, objectIds: { knowledge_item: itemId, path: markdownPath } };
      },
      record: async (tx, operation) => {
        if (!planned) throw new DomainError('INTERNAL_ERROR', 'the item was never planned');
        const p = planned;
        const item: KnowledgeItemRecord = {
          id: itemId,
          workspaceId: actor.workspaceId,
          slug: p.slug,
          markdownPath: p.markdownPath,
          type: input.type,
          status: 'active',
          language: p.frontmatter.language,
          currentRevisionId: revisionId,
          reviewState: p.frontmatter.review,
          evidenceState: 'none',
          disputed: false,
          validFrom: p.frontmatter.valid_from ? new Date(p.frontmatter.valid_from) : null,
          validUntil: p.frontmatter.valid_until ? new Date(p.frontmatter.valid_until) : null,
          observedAt: p.frontmatter.observed_at ? new Date(p.frontmatter.observed_at) : null,
          sourceSystem: input.external?.source_system ?? null,
          externalKey: input.external?.external_key ?? null,
          createdByActorId: actor.actorId,
          createdAt: p.now,
          updatedAt: p.now,
          deletedAt: null,
        };
        const revision: RevisionRecord = {
          id: revisionId,
          knowledgeItemId: itemId,
          workspaceId: actor.workspaceId,
          revisionNumber: 1,
          contentHash: this.o.contentHash(p.frontmatter.title, p.body),
          // The whole file minus the body: what changed about the metadata is
          // what this distinguishes, so a metadata-only revision is visible.
          frontmatterHash: this.o.frontmatterHash(
            p.rendered.slice(0, p.rendered.indexOf('\n---\n') + 5),
          ),
          gitCommitHash: p.commitHash,
          title: p.frontmatter.title,
          markdownPath: p.markdownPath,
          frontmatter: p.frontmatter,
          changeKind: 'create',
          createdByActorId: actor.actorId,
          createdAt: p.now,
          operationId: operation.id,
        };
        await this.o.items.insert(tx, item);
        await this.o.revisions.insert(tx, revision);
        await this.o.items.setCategories(
          tx,
          itemId,
          p.chosen.map<ItemCategoryRecord>((category, index) => ({
            knowledgeItemId: itemId,
            categoryId: category.id,
            isPrimary: index === 0,
            position: index,
          })),
        );
        await this.o.items.setTags(tx, actor.workspaceId, itemId, p.frontmatter.tags);
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.created',
          objectType: 'knowledge_item',
          objectId: itemId,
          categoryIds: p.chosen.map((c) => c.id),
          // No title and no body: the ledger holds ids, hashes and actor
          // context, never the knowledge itself.
          metadata: {
            revision: revisionId,
            content_hash: revision.contentHash,
            git_commit: p.commitHash,
            item_type: input.type,
          },
        });
        return {
          item,
          revision,
          categories: p.chosen.map((c) => c.path),
          tags: p.frontmatter.tags,
          body: p.body,
        };
      },
    });
  }

  /** One item with its body, read from the file that is canonical. */
  async get(actor: ActorContext, itemId: KnowledgeItemId): Promise<ItemResult> {
    const item = await this.o.items.findById(actor.workspaceId, itemId);
    if (!item || item.deletedAt) {
      throw new DomainError('NOT_FOUND', 'knowledge item not found', {
        objectIds: { knowledge_item: itemId },
      });
    }
    const revision = item.currentRevisionId
      ? await this.o.revisions.findById(actor.workspaceId, item.currentRevisionId)
      : null;
    if (!revision) {
      throw new DomainError('INTERNAL_ERROR', 'the item has no current revision', {
        objectIds: { knowledge_item: itemId },
      });
    }
    const file = await this.o.git.read(actor.workspaceId, item.markdownPath);
    if (file === null) {
      // The database says the item exists and the repository does not have it.
      // That is the corruption the architecture calls unrepairable, so it is
      // reported rather than papered over with an empty body.
      throw new DomainError(
        'INTERNAL_ERROR',
        'the repository does not contain the file this item names; restore it from a backup',
        { objectIds: { knowledge_item: itemId, path: item.markdownPath } },
      );
    }
    const { categories, tags } = await this.decorate(actor.workspaceId, [item]);
    return {
      item,
      revision,
      categories: categories.get(item.id) ?? [],
      tags: tags.get(item.id) ?? [],
      body: this.o.parseItem(file).body,
    };
  }

  /** A page of items without their bodies: a list does not need the knowledge. */
  async list(actor: ActorContext, options: ListItemsOptions = {}): Promise<ItemSummary[]> {
    const items = await this.o.items.list(actor.workspaceId, options);
    const { categories, tags } = await this.decorate(actor.workspaceId, items);
    const revisionIds = items.map((i) => i.currentRevisionId).filter((id) => id !== null);
    const titles = new Map<string, string>();
    for (const id of revisionIds) {
      const revision = await this.o.revisions.findById(actor.workspaceId, id);
      if (revision) titles.set(revision.id, revision.title);
    }
    return items.map((item) => ({
      item,
      title: item.currentRevisionId ? (titles.get(item.currentRevisionId) ?? '') : '',
      categories: categories.get(item.id) ?? [],
      tags: tags.get(item.id) ?? [],
    }));
  }

  private async decorate(
    workspaceId: WorkspaceId,
    items: readonly KnowledgeItemRecord[],
  ): Promise<{ categories: Map<string, string[]>; tags: Map<string, string[]> }> {
    const ids = items.map((i) => i.id);
    const joins = await this.o.items.categoriesOf(workspaceId, ids);
    const tree = await this.o.categories.list(workspaceId, { includeArchived: true });
    const byId = new Map(tree.map((c) => [c.id, c.path]));
    const categories = new Map<string, string[]>();
    for (const join of [...joins].sort((a, b) => a.position - b.position)) {
      const path = byId.get(join.categoryId);
      if (!path) continue;
      categories.set(join.knowledgeItemId, [...(categories.get(join.knowledgeItemId) ?? []), path]);
    }
    const tags = await this.o.items.tagsOf(workspaceId, ids);
    return { categories, tags: new Map(tags) };
  }

  /**
   * Refuses to write into a repository that is not the one this workspace's
   * records describe — lost, replaced, or somebody else's. The newest commit
   * anything recorded is the anchor; a workspace that has never written has
   * nothing to check and starts cleanly.
   */
  private async assertRepositoryIsOurs(workspaceId: WorkspaceId): Promise<void> {
    const anchor =
      (await this.o.revisions.latestCommit(workspaceId)) ??
      (await this.o.versions.latest(workspaceId))?.gitCommitHash ??
      null;
    if (anchor && !(await this.o.git.hasCommit(workspaceId, anchor))) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'the workspace repository does not contain the commit this workspace was last written with; restore it from a backup before writing again',
        { objectIds: { workspace_id: workspaceId, commit: anchor } },
      );
    }
  }

  private resolveCategories(
    tree: readonly CategoryRecord[],
    paths: readonly string[],
  ): CategoryRecord[] {
    const seen = new Set<string>();
    return paths.map((path) => {
      if (seen.has(path)) {
        throw new DomainError('VALIDATION_ERROR', `the category ${path} is listed twice`);
      }
      seen.add(path);
      const category = tree.find((c) => c.path === path);
      if (!category) {
        throw new DomainError('NOT_FOUND', `no category at ${path}`, { objectIds: { path } });
      }
      if (category.status !== 'active') {
        throw new DomainError('CATEGORY_CONFLICT', `the category ${path} is not active`, {
          objectIds: { path },
        });
      }
      return category;
    });
  }

  private parseSlug(slug: string): string {
    const parsed = CategorySlug.safeParse(slug);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', `not a usable slug: ${slug}`);
    }
    return parsed.data;
  }

  /** The commit author: the actor, so the log points back at who wrote it. */
  private async authorOf(actor: ActorContext): Promise<CommitAuthor> {
    const record = await this.o.actors.findById(actor.workspaceId, actor.actorId);
    return {
      name: record?.displayName ?? 'Knoverge',
      email: `${actor.actorId}@knoverge.local`,
    };
  }
}

interface PlannedItem {
  frontmatter: Frontmatter;
  body: string;
  slug: string;
  markdownPath: string;
  chosen: CategoryRecord[];
  rendered: string;
  now: Date;
  commitHash: string;
}
