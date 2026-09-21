import {
  CategorySlug,
  FRONTMATTER_KEY_ORDER,
  type ActorId,
  type Frontmatter,
  type ChangeKind,
  type EvidenceState,
  type FrontmatterRelation,
  type FrontmatterSource,
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
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type {
  CategoryRecord,
  CategoryRepository,
  TaxonomyVersionRepository,
} from '../taxonomy/repository.ts';
import type {
  ItemCategoryRecord,
  ListItemsOptions,
  RelationRepository,
  SourceRepository,
  KnowledgeItemRecord,
  KnowledgeRepository,
  RevisionRecord,
  RevisionRepository,
} from './repository.ts';

/**
 * `source_backed` needs a source somebody else could check: a locator, or a
 * fingerprint of the bytes (KNOWLEDGE_MODEL.md section 8). A source with
 * neither is an assertion about where something came from, not evidence of it.
 *
 * `corroborated` is two or more independent sources and is decided by review
 * rather than by counting, so nothing here ever sets it.
 */
export function evidenceFrom(sources: readonly FrontmatterSource[]): EvidenceState {
  return sources.some((s) => s.uri !== undefined || s.content_hash !== undefined)
    ? 'source_backed'
    : 'none';
}

/** One frontmatter field that differs between two revisions. */
export interface MetadataChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * The frontmatter fields that differ, in the order the file writes them.
 *
 * `updated_at` is skipped: it differs by construction on every revision, and a
 * list of changes whose first entry is always the same one is a list people
 * stop reading.
 */
export function compareFrontmatter(from: Frontmatter, to: Frontmatter): MetadataChange[] {
  const changes: MetadataChange[] = [];
  for (const field of FRONTMATTER_KEY_ORDER) {
    if (field === 'updated_at') continue;
    const before = (from as Record<string, unknown>)[field];
    const after = (to as Record<string, unknown>)[field];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      changes.push({ field, from: before ?? null, to: after ?? null });
    }
  }
  return changes;
}

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
  findById(
    workspaceId: WorkspaceId,
  ): Promise<{ id: WorkspaceId; name: string; defaultLanguage: string } | null>;
}

export interface KnowledgeServiceOptions {
  uow: UnitOfWork;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  sources: SourceRepository;
  relations: RelationRepository;
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

export interface DeleteItemInput {
  itemId: KnowledgeItemId;
  baseRevisionId: RevisionId;
  baseContentHash: string;
}

export interface UpdateItemInput {
  itemId: KnowledgeItemId;
  /** What the caller read. A mismatch is a conflict, never an overwrite. */
  baseRevisionId: RevisionId;
  baseContentHash: string;
  title?: string | undefined;
  body?: string | undefined;
  type?: ItemType | undefined;
  language?: string | undefined;
  /** Replaces the whole list when given; the first is still primary. */
  categories?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  observedAt?: string | null | undefined;
  sources?: readonly FrontmatterSource[] | undefined;
  relations?: readonly FrontmatterRelation[] | undefined;
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
  sources?: readonly FrontmatterSource[] | undefined;
  relations?: readonly FrontmatterRelation[] | undefined;
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

        // The workspace's own language when the caller does not say. A
        // hard-coded 'en' made every item in a Russian workspace claim to be
        // English, which drives the full-text search configuration.
        const language = input.language ?? workspace.defaultLanguage;
        const frontmatter: Frontmatter = {
          id: itemId,
          title,
          type: input.type,
          status: 'active',
          language,
          categories: chosen.map((c) => c.path),
          tags: [...new Set(input.tags ?? [])].sort(),
          review: actor.actorType === 'human' ? 'human_reviewed' : 'unreviewed',
          evidence: evidenceFrom(input.sources ?? []),
          disputed: false,
          valid_from: input.validFrom ?? null,
          valid_until: input.validUntil ?? null,
          observed_at: input.observedAt ?? null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          sources: [...(input.sources ?? [])],
          relations: [...(input.relations ?? [])],
          ...(input.external ? { external: input.external } : {}),
        } as Frontmatter;

        await this.assertRelationTargets(actor.workspaceId, itemId, frontmatter.relations);
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
          evidenceState: p.frontmatter.evidence,
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
        await this.writeSources(tx, actor.workspaceId, revisionId, p.frontmatter.sources, p.now);
        await this.writeRelations(tx, actor, itemId, p.frontmatter.relations, p.now);
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

  /**
   * Changes an item: a new revision and a new commit, always.
   *
   * The caller says which revision and which content it read, and a mismatch
   * is a conflict rather than an overwrite (rule 6). Two people editing the
   * same item is ordinary; one of them silently losing their work is not.
   *
   * A change of primary category moves the file, in the same commit, because
   * the path is derived from the category and a file left behind would be an
   * item the repository has twice.
   */
  async update(actor: ActorContext, input: UpdateItemInput): Promise<ItemResult> {
    const current = await this.get(actor, input.itemId);
    if (
      current.revision.id !== input.baseRevisionId ||
      current.revision.contentHash !== input.baseContentHash
    ) {
      throw new DomainError(
        'REVISION_CONFLICT',
        'the item changed since you read it; re-read it and apply your change to the current revision',
        {
          objectIds: {
            knowledge_item: input.itemId,
            current_revision_id: current.revision.id,
            current_content_hash: current.revision.contentHash,
          },
        },
      );
    }

    const title = (input.title ?? current.revision.title).trim();
    if (title === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a title');
    const body = (input.body ?? current.body).trim();
    if (body === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a body');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new DomainError('VALIDATION_ERROR', `the body may not exceed ${MAX_BODY_BYTES} bytes`);
    }
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedUpdate | undefined;

    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'update',
      objectIds: { knowledge_item: input.itemId },
      commit: async (operation) => {
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.assertRepositoryIsOurs(actor.workspaceId);

        const tree = await this.o.categories.list(actor.workspaceId, { includeArchived: true });
        const chosen = this.resolveCategories(tree, input.categories ?? current.categories);
        const directory = chosen[0] ? `knowledge/${chosen[0].path}` : UNCATEGORISED_DIRECTORY;
        const previousPath = current.item.markdownPath;
        const markdownPath = `${directory}/${current.item.slug}.md`;
        const moved = markdownPath !== previousPath;
        if (moved && (await this.o.items.findByPath(actor.workspaceId, markdownPath))) {
          throw new DomainError('VALIDATION_ERROR', 'another item already holds that path', {
            objectIds: { path: markdownPath },
          });
        }

        const previous = current.revision.frontmatter;
        // Both sides trimmed: the body read back from the file carries the
        // trailing newline normalisation adds, and comparing against it
        // unmodified made every metadata change look like a text change.
        const bodyChanged = body !== current.body.trim();
        const frontmatter: Frontmatter = {
          ...previous,
          title,
          type: input.type ?? previous.type,
          language: input.language ?? previous.language,
          categories: chosen.map((c) => c.path),
          tags: input.tags ? [...new Set(input.tags)].sort() : previous.tags,
          // A new revision resets review unless a human made it
          // (KNOWLEDGE_MODEL.md section 8): what was reviewed was the text
          // that changed.
          review: actor.actorType === 'human' ? 'human_reviewed' : 'unreviewed',
          sources: input.sources ? [...input.sources] : previous.sources,
          relations: input.relations ? [...input.relations] : previous.relations,
          evidence: evidenceFrom(input.sources ?? previous.sources),
          valid_from: input.validFrom === undefined ? previous.valid_from : input.validFrom,
          valid_until: input.validUntil === undefined ? previous.valid_until : input.validUntil,
          observed_at: input.observedAt === undefined ? previous.observed_at : input.observedAt,
          updated_at: now.toISOString(),
        } as Frontmatter;

        await this.assertRelationTargets(actor.workspaceId, input.itemId, frontmatter.relations);
        const rendered = this.o.renderItem({ frontmatter, body });
        if (moved) await this.o.git.remove(actor.workspaceId, [previousPath]);
        await this.o.git.write(actor.workspaceId, [{ path: markdownPath, content: rendered }]);
        const kind = moved ? 'move' : bodyChanged ? 'update' : 'metadata';
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: moved ? [previousPath, markdownPath] : [markdownPath],
          subject: `${moved ? 'move' : 'update'}(${frontmatter.type}): ${title}`,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            ['Knoverge-Change', `${input.itemId}@${revisionId} ${kind}`],
          ],
          author,
          at: now,
        });
        if (commitHash === null) {
          throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
        }
        planned = { frontmatter, body, markdownPath, chosen, rendered, now, commitHash, kind };
        return { commitHash, objectIds: { knowledge_item: input.itemId, path: markdownPath } };
      },
      record: async (tx, operation) => {
        if (!planned) throw new DomainError('INTERNAL_ERROR', 'the change was never planned');
        const p = planned;
        const revision = this.revisionOf(
          actor,
          input.itemId,
          revisionId,
          current.revision.revisionNumber + 1,
          p,
          operation.id,
        );
        await this.o.revisions.insert(tx, revision);
        await this.o.items.update(tx, input.itemId, {
          markdownPath: p.markdownPath,
          language: p.frontmatter.language,
          currentRevisionId: revisionId,
          reviewState: p.frontmatter.review,
          evidenceState: p.frontmatter.evidence,
          validFrom: p.frontmatter.valid_from ? new Date(p.frontmatter.valid_from) : null,
          validUntil: p.frontmatter.valid_until ? new Date(p.frontmatter.valid_until) : null,
          observedAt: p.frontmatter.observed_at ? new Date(p.frontmatter.observed_at) : null,
          updatedAt: p.now,
        });
        await this.o.items.setCategories(
          tx,
          input.itemId,
          p.chosen.map<ItemCategoryRecord>((category, index) => ({
            knowledgeItemId: input.itemId,
            categoryId: category.id,
            isPrimary: index === 0,
            position: index,
          })),
        );
        await this.o.items.setTags(tx, actor.workspaceId, input.itemId, p.frontmatter.tags);
        await this.writeSources(tx, actor.workspaceId, revisionId, p.frontmatter.sources, p.now);
        await this.writeRelations(tx, actor, input.itemId, p.frontmatter.relations, p.now);
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: p.kind === 'move' ? 'knowledge.moved' : 'knowledge.updated',
          objectType: 'knowledge_item',
          objectId: input.itemId,
          categoryIds: p.chosen.map((c) => c.id),
          metadata: {
            revision: revisionId,
            before_revision: current.revision.id,
            before_hash: current.revision.contentHash,
            content_hash: revision.contentHash,
            git_commit: p.commitHash,
            change_kind: p.kind,
          },
        });
        return {
          item: (await this.o.items.findById(actor.workspaceId, input.itemId, tx)) as never,
          revision,
          categories: p.chosen.map((c) => c.path),
          tags: p.frontmatter.tags,
          body: p.body,
        };
      },
    });
  }

  /**
   * Removes an item from the current index.
   *
   * Logical: the file leaves the working tree and every commit that had it
   * keeps it, so the knowledge is still there for anyone allowed to read
   * history, and a restore is a commit rather than an archaeology exercise.
   */
  async delete(actor: ActorContext, input: DeleteItemInput): Promise<ItemResult> {
    const current = await this.get(actor, input.itemId);
    if (
      current.revision.id !== input.baseRevisionId ||
      current.revision.contentHash !== input.baseContentHash
    ) {
      throw new DomainError(
        'REVISION_CONFLICT',
        'the item changed since you read it; re-read it before deleting',
        {
          objectIds: {
            knowledge_item: input.itemId,
            current_revision_id: current.revision.id,
            current_content_hash: current.revision.contentHash,
          },
        },
      );
    }
    return this.retire(actor, current, 'delete');
  }

  /** Brings back an item a delete removed, at the content it had. */
  async restore(actor: ActorContext, itemId: KnowledgeItemId): Promise<ItemResult> {
    const item = await this.o.items.findById(actor.workspaceId, itemId);
    if (!item) {
      throw new DomainError('NOT_FOUND', 'knowledge item not found', {
        objectIds: { knowledge_item: itemId },
      });
    }
    if (item.status !== 'deleted') {
      throw new DomainError('VALIDATION_ERROR', 'this item is not deleted');
    }
    const revision = item.currentRevisionId
      ? await this.o.revisions.findById(actor.workspaceId, item.currentRevisionId)
      : null;
    if (!revision) {
      throw new DomainError('INTERNAL_ERROR', 'the item has no current revision');
    }
    // The delete revision recorded the commit the file was removed in, so the
    // content is in that commit's parent — which is where the previous
    // revision's own commit is. Reading it is how a restore restores.
    const previous = (await this.o.revisions.listForItem(itemId, 2))[1];
    if (!previous) {
      throw new DomainError('INTERNAL_ERROR', 'nothing to restore this item from');
    }
    const file = await this.o.git.readAt(
      actor.workspaceId,
      previous.gitCommitHash,
      previous.markdownPath,
    );
    if (file === null) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'the commit this item was last written in no longer has its file',
        { objectIds: { knowledge_item: itemId, commit: previous.gitCommitHash } },
      );
    }
    const parsed = this.o.parseItem(file);
    return this.reinstate(actor, item, revision, previous, parsed.body);
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

  /** Every revision of an item, newest first. */
  async history(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    limit = 50,
  ): Promise<RevisionRecord[]> {
    const item = await this.o.items.findById(actor.workspaceId, itemId);
    if (!item) {
      throw new DomainError('NOT_FOUND', 'knowledge item not found', {
        objectIds: { knowledge_item: itemId },
      });
    }
    return this.o.revisions.listForItem(itemId, limit);
  }

  /**
   * What changed between two revisions of one item.
   *
   * The text comes from Git, which is where the text is; the metadata is
   * compared field by field from the two revisions, because a reader asking
   * what changed about an item wants the answer rather than a patch to read it
   * out of.
   */
  async diff(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    fromRevisionId: RevisionId,
    toRevisionId: RevisionId,
  ): Promise<{
    from: RevisionRecord;
    to: RevisionRecord;
    bodyDiff: string;
    metadata: MetadataChange[];
  }> {
    const [from, to] = await Promise.all([
      this.o.revisions.findById(actor.workspaceId, fromRevisionId),
      this.o.revisions.findById(actor.workspaceId, toRevisionId),
    ]);
    if (!from || !to) {
      throw new DomainError('NOT_FOUND', 'revision not found', {
        objectIds: { knowledge_item: itemId },
      });
    }
    if (from.knowledgeItemId !== itemId || to.knowledgeItemId !== itemId) {
      throw new DomainError('VALIDATION_ERROR', 'those revisions belong to different items', {
        objectIds: { knowledge_item: itemId },
      });
    }
    const bodyDiff = await this.o.git.diffFiles(
      actor.workspaceId,
      { commitHash: from.gitCommitHash, path: from.markdownPath },
      { commitHash: to.gitCommitHash, path: to.markdownPath },
    );
    return { from, to, bodyDiff, metadata: compareFrontmatter(from.frontmatter, to.frontmatter) };
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

  /** The commit and the rows that take an item out of the working tree. */
  private async retire(
    actor: ActorContext,
    current: ItemResult,
    kind: 'delete',
  ): Promise<ItemResult> {
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedUpdate | undefined;
    const itemId = current.item.id;
    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'delete',
      objectIds: { knowledge_item: itemId },
      commit: async (operation) => {
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.assertRepositoryIsOurs(actor.workspaceId);
        const frontmatter: Frontmatter = {
          ...current.revision.frontmatter,
          status: 'deleted',
          updated_at: now.toISOString(),
        } as Frontmatter;
        await this.o.git.remove(actor.workspaceId, [current.item.markdownPath]);
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: [current.item.markdownPath],
          subject: `delete(${frontmatter.type}): ${current.revision.title}`,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            ['Knoverge-Change', `${itemId}@${revisionId} ${kind}`],
          ],
          author,
          at: now,
        });
        if (commitHash === null) {
          throw new DomainError('INTERNAL_ERROR', 'the file was already gone from the tree');
        }
        planned = {
          frontmatter,
          body: current.body,
          markdownPath: current.item.markdownPath,
          chosen: [],
          // The file is gone, so the frontmatter hash is taken from what the
          // delete revision records rather than from a file on disk.
          rendered: this.o.renderItem({ frontmatter, body: current.body }),
          now,
          commitHash,
          kind,
        };
        return { commitHash, objectIds: { knowledge_item: itemId } };
      },
      record: async (tx, operation) => {
        if (!planned) throw new DomainError('INTERNAL_ERROR', 'the delete was never planned');
        const p = planned;
        const revision = this.revisionOf(
          actor,
          itemId,
          revisionId,
          current.revision.revisionNumber + 1,
          p,
          operation.id,
        );
        await this.o.revisions.insert(tx, revision);
        await this.o.items.update(tx, itemId, {
          status: 'deleted',
          currentRevisionId: revisionId,
          deletedAt: p.now,
          updatedAt: p.now,
        });
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.deleted',
          objectType: 'knowledge_item',
          objectId: itemId,
          metadata: {
            revision: revisionId,
            before_revision: current.revision.id,
            git_commit: p.commitHash,
          },
        });
        return { ...current, revision, item: { ...current.item, status: 'deleted' } };
      },
    });
  }

  /** The commit and the rows that put a deleted item back. */
  private async reinstate(
    actor: ActorContext,
    item: KnowledgeItemRecord,
    deleteRevision: RevisionRecord,
    previous: RevisionRecord,
    body: string,
  ): Promise<ItemResult> {
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedUpdate | undefined;
    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'restore',
      objectIds: { knowledge_item: item.id },
      commit: async (operation) => {
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.assertRepositoryIsOurs(actor.workspaceId);
        const tree = await this.o.categories.list(actor.workspaceId, { includeArchived: true });
        // The categories the item had. One archived since is refused rather
        // than quietly dropped: where the item belongs is part of the item.
        const chosen = this.resolveCategories(tree, previous.frontmatter.categories);
        const frontmatter: Frontmatter = {
          ...previous.frontmatter,
          status: 'active',
          updated_at: now.toISOString(),
        } as Frontmatter;
        const rendered = this.o.renderItem({ frontmatter, body });
        await this.o.git.write(actor.workspaceId, [
          { path: previous.markdownPath, content: rendered },
        ]);
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: [previous.markdownPath],
          subject: `restore(${frontmatter.type}): ${previous.title}`,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            ['Knoverge-Change', `${item.id}@${revisionId} restore`],
          ],
          author,
          at: now,
        });
        if (commitHash === null) {
          throw new DomainError('INTERNAL_ERROR', 'the restore produced no commit');
        }
        planned = {
          frontmatter,
          body,
          markdownPath: previous.markdownPath,
          chosen,
          rendered,
          now,
          commitHash,
          kind: 'restore',
        };
        return { commitHash, objectIds: { knowledge_item: item.id } };
      },
      record: async (tx, operation) => {
        if (!planned) throw new DomainError('INTERNAL_ERROR', 'the restore was never planned');
        const p = planned;
        const revision = this.revisionOf(
          actor,
          item.id,
          revisionId,
          deleteRevision.revisionNumber + 1,
          p,
          operation.id,
        );
        await this.o.revisions.insert(tx, revision);
        await this.o.items.update(tx, item.id, {
          status: 'active',
          markdownPath: p.markdownPath,
          currentRevisionId: revisionId,
          deletedAt: null,
          updatedAt: p.now,
        });
        await this.o.items.setCategories(
          tx,
          item.id,
          p.chosen.map<ItemCategoryRecord>((category, index) => ({
            knowledgeItemId: item.id,
            categoryId: category.id,
            isPrimary: index === 0,
            position: index,
          })),
        );
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.restored',
          objectType: 'knowledge_item',
          objectId: item.id,
          categoryIds: p.chosen.map((c) => c.id),
          metadata: {
            revision: revisionId,
            restored_from: previous.id,
            git_commit: p.commitHash,
          },
        });
        return {
          item: { ...item, status: 'active', currentRevisionId: revisionId, deletedAt: null },
          revision,
          categories: p.chosen.map((c) => c.path),
          tags: p.frontmatter.tags,
          body: p.body,
        };
      },
    });
  }

  /**
   * The sources a revision rested on. Attached to the revision rather than to
   * the item, because which sources were cited is part of what the revision
   * said — an older revision keeps its own even after the item moves on.
   */
  private async writeSources(
    tx: Tx,
    workspaceId: WorkspaceId,
    revisionId: RevisionId,
    sources: readonly FrontmatterSource[],
    at: Date,
  ): Promise<void> {
    if (sources.length === 0) return;
    const ids = await this.o.sources.ensure(
      tx,
      workspaceId,
      sources.map((source) => ({
        sourceType: source.type,
        uri: source.uri ?? null,
        externalSystem: source.client ?? null,
        externalKey: source.external_key ?? null,
        attachmentId: null,
        sourceModifiedAt: null,
        sourceContentHash: source.content_hash ?? null,
        confidence: null,
        metadata: source.session_id ? { session_id: source.session_id } : {},
      })),
      at,
    );
    await this.o.sources.attachToRevision(
      tx,
      ids.map((sourceReferenceId, index) => ({
        revisionId,
        sourceReferenceId,
        evidenceRole: sources[index]!.role,
        position: index,
      })),
    );
  }

  /**
   * The item's live relations, made exactly what the frontmatter says.
   *
   * The file carries the portable copy and PostgreSQL the queryable one, and
   * rule 2 makes the database the authority for querying — so the two are
   * written together or not at all.
   */
  /**
   * Refuses a relation whose target is not an item in this workspace.
   *
   * The foreign key would catch it too, but as an internal error on the way
   * out — a caller who mistyped an id deserves to be told that, and told it
   * before anything was committed to Git.
   */
  private async assertRelationTargets(
    workspaceId: WorkspaceId,
    itemId: KnowledgeItemId,
    relations: readonly FrontmatterRelation[],
  ): Promise<void> {
    for (const relation of relations) {
      if (relation.target === itemId) {
        throw new DomainError('VALIDATION_ERROR', 'an item cannot relate to itself');
      }
    }
    await this.assertRelationTargetsExist(workspaceId, relations);
  }

  /**
   * That every item a relation names is one the workspace has.
   *
   * Public because a proposal is checked before it is recorded: a pending
   * proposal pointing at nothing could never be applied, and a reviewer would
   * find that out only on approving it. A write additionally rules out the
   * item relating to itself, which a proposal has no id to compare against.
   */
  async assertRelationTargetsExist(
    workspaceId: WorkspaceId,
    relations: readonly FrontmatterRelation[],
  ): Promise<void> {
    for (const relation of relations) {
      if (!(await this.o.items.findById(workspaceId, relation.target))) {
        throw new DomainError('NOT_FOUND', `no knowledge item ${relation.target}`, {
          objectIds: { knowledge_item: relation.target },
        });
      }
    }
  }

  private async writeRelations(
    tx: Tx,
    actor: ActorContext,
    itemId: KnowledgeItemId,
    relations: readonly FrontmatterRelation[],
    at: Date,
  ): Promise<void> {
    await this.o.relations.replaceForItem(
      tx,
      actor.workspaceId,
      itemId,
      relations.map((relation) => ({
        relationType: relation.type,
        toItemId: relation.target,
        validFrom: relation.valid_from ? new Date(relation.valid_from) : null,
        validUntil: relation.valid_until ? new Date(relation.valid_until) : null,
        createdByActorId: actor.actorId,
      })),
      at,
    );
  }

  /** One revision row from a planned change, so create and update agree. */
  private revisionOf(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    revisionId: RevisionId,
    revisionNumber: number,
    planned: {
      frontmatter: Frontmatter;
      body: string;
      markdownPath: string;
      rendered: string;
      now: Date;
      commitHash: string;
      kind?: ChangeKind;
    },
    operationId: string,
  ): RevisionRecord {
    return {
      id: revisionId,
      knowledgeItemId: itemId,
      workspaceId: actor.workspaceId,
      revisionNumber,
      contentHash: this.o.contentHash(planned.frontmatter.title, planned.body),
      // The whole file minus the body, so a metadata-only change is visible as
      // a different revision even though the content hash did not move.
      frontmatterHash: this.o.frontmatterHash(
        planned.rendered.slice(0, planned.rendered.indexOf('\n---\n') + 5),
      ),
      gitCommitHash: planned.commitHash,
      title: planned.frontmatter.title,
      markdownPath: planned.markdownPath,
      frontmatter: planned.frontmatter,
      changeKind: planned.kind ?? 'create',
      createdByActorId: actor.actorId,
      createdAt: planned.now,
      operationId,
    };
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

interface PlannedUpdate {
  frontmatter: Frontmatter;
  body: string;
  markdownPath: string;
  chosen: CategoryRecord[];
  rendered: string;
  now: Date;
  commitHash: string;
  kind: ChangeKind;
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
