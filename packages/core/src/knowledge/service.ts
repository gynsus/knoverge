import {
  ItemSlug,
  type ChangeKind,
  type Frontmatter,
  type FrontmatterRelation,
  type FrontmatterSource,
  type KnowledgeItemId,
  type ProposalId,
  type RevisionId,
  type WorkspaceId,
} from '@knoverge/contracts';

import { chunksFor } from './chunks.ts';
import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { CommitAuthor } from '../ports/git-store.ts';
import type { Tx } from '../ports/unit-of-work.ts';
import type { CategoryRecord } from '../taxonomy/repository.ts';
import type {
  ItemCategoryRecord,
  KnowledgePiles,
  ListItemsOptions,
  KnowledgeItemRecord,
  RevisionRecord,
} from './repository.ts';
import { compareFrontmatter, evidenceFrom, tagList, type MetadataChange } from './frontmatter.ts';
import type {
  CreateItemInput,
  DeleteItemInput,
  ItemResult,
  ItemSummary,
  KnowledgeServiceOptions,
  SupersedeInput,
  SupersedeResult,
  UpdateItemInput,
} from './types.ts';

export { compareFrontmatter, evidenceFrom, type MetadataChange } from './frontmatter.ts';
export type {
  CreateItemInput,
  DeleteItemInput,
  ItemResult,
  ItemSummary,
  KnowledgeServiceOptions,
  SupersedeInput,
  SupersedeResult,
  UpdateItemInput,
} from './types.ts';

export const UNCATEGORISED_DIRECTORY = 'knowledge/_uncategorised';

/** The knowledge itself. A document is meant to be long; this is the ceiling. */
export const MAX_BODY_BYTES = 200_000;

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
          tags: tagList(input.tags ?? []),
          review: input.review ?? (actor.actorType === 'human' ? 'human_reviewed' : 'unreviewed'),
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
            ...(input.proposalId
              ? ([['Knoverge-Proposal', input.proposalId]] as [string, string][])
              : []),
            // What recovery needs to rebuild the PostgreSQL side from the
            // commit alone: which item, which revision, and what happened.
            ['Knoverge-Change', `${itemId}@${revisionId} create`],
          ],
          author,
          at: now,
          ...(input.reason ? { body: input.reason } : {}),
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
          reason: input.reason ?? null,
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
        await this.index(tx, actor.workspaceId, itemId, revisionId, p.frontmatter, p.body, p.now);
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
            frontmatter_hash: revision.frontmatterHash,
            git_commit: p.commitHash,
            item_type: input.type,
            categories_before: [],
            categories_after: p.chosen.map((c) => c.id),
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
   * The item as it is now, refused unless it is the revision the caller read.
   *
   * Rule 6, and the reason this takes a method of its own: it has to be called
   * from inside the commit step, which runs under the workspace lock. Asked
   * before the lock, the answer is a snapshot two writers can both pass — and
   * the later one then renders its file from a revision that is no longer
   * there, taking a revision number that is already taken. The commit lands in
   * Git, the insert fails, and the workspace is left holding an unfinished
   * operation that refuses every write until an operator resolves it.
   */
  private async currentFor(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    baseRevisionId: RevisionId,
    baseContentHash: string,
    message: string,
  ): Promise<ItemResult> {
    const current = await this.get(actor, itemId);
    if (
      current.revision.id !== baseRevisionId ||
      current.revision.contentHash !== baseContentHash
    ) {
      throw new DomainError('REVISION_CONFLICT', message, {
        objectIds: {
          knowledge_item: itemId,
          current_revision_id: current.revision.id,
          current_content_hash: current.revision.contentHash,
        },
      });
    }
    return current;
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
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedUpdate | undefined;
    // Read inside the commit step, which holds the workspace lock, and used by
    // the record step afterwards. See currentFor().
    let current: ItemResult | undefined;

    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'update',
      objectIds: { knowledge_item: input.itemId },
      commit: async (operation) => {
        current = await this.currentFor(
          actor,
          input.itemId,
          input.baseRevisionId,
          input.baseContentHash,
          'the item changed since you read it; re-read it and apply your change to the current revision',
        );
        const title = (input.title ?? current.revision.title).trim();
        if (title === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a title');
        const body = (input.body ?? current.body).trim();
        if (body === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a body');
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          throw new DomainError(
            'VALIDATION_ERROR',
            `the body may not exceed ${MAX_BODY_BYTES} bytes`,
          );
        }
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
          tags: input.tags ? tagList(input.tags) : previous.tags,
          // A new revision resets review unless a human made it
          // (KNOWLEDGE_MODEL.md section 8): what was reviewed was the text
          // that changed. The review workflow says so explicitly instead,
          // because who approved is not always who is writing.
          review: input.review ?? (actor.actorType === 'human' ? 'human_reviewed' : 'unreviewed'),
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
            ...(input.proposalId
              ? ([['Knoverge-Proposal', input.proposalId]] as [string, string][])
              : []),
            ['Knoverge-Change', `${input.itemId}@${revisionId} ${kind}`],
          ],
          author,
          at: now,
          ...(input.reason ? { body: input.reason } : {}),
        });
        if (commitHash === null) {
          throw new DomainError('VALIDATION_ERROR', 'this change would alter nothing');
        }
        planned = {
          frontmatter,
          body,
          markdownPath,
          chosen,
          rendered,
          now,
          commitHash,
          kind,
          ...(input.reason ? { reason: input.reason } : {}),
        };
        return { commitHash, objectIds: { knowledge_item: input.itemId, path: markdownPath } };
      },
      record: async (tx, operation) => {
        if (!planned || !current) {
          throw new DomainError('INTERNAL_ERROR', 'the change was never planned');
        }
        const p = planned;
        const was = current.revision;
        const revision = this.revisionOf(
          actor,
          input.itemId,
          revisionId,
          was.revisionNumber + 1,
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
        // Read before the write, because the change feed has to say what an
        // item moved out of as well as what it moved into: an item that left
        // the caller's scope must reach them as a removal rather than simply
        // stop appearing (ADR 0010).
        const before = (await this.o.items.categoriesOf(actor.workspaceId, [input.itemId])).map(
          (row) => row.categoryId as string,
        );
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
        await this.index(
          tx,
          actor.workspaceId,
          input.itemId,
          revisionId,
          p.frontmatter,
          p.body,
          p.now,
        );
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: p.kind === 'move' ? 'knowledge.moved' : 'knowledge.updated',
          objectType: 'knowledge_item',
          objectId: input.itemId,
          // Both sides, so the filter matches whoever could see the item
          // before as well as whoever can see it now.
          categoryIds: [...new Set([...before, ...p.chosen.map((c) => c.id)])],
          metadata: {
            revision: revisionId,
            before_revision: was.id,
            before_hash: was.contentHash,
            content_hash: revision.contentHash,
            frontmatter_hash: revision.frontmatterHash,
            git_commit: p.commitHash,
            change_kind: p.kind,
            categories_before: before,
            categories_after: p.chosen.map((c) => c.id),
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
    return this.retire(
      actor,
      input.itemId,
      () =>
        this.currentFor(
          actor,
          input.itemId,
          input.baseRevisionId,
          input.baseContentHash,
          'the item changed since you read it; re-read it before deleting',
        ),
      'delete',
      input.proposalId,
      input.reason,
    );
  }

  /**
   * Replacing one item with another, as one operation.
   *
   * A fact that changed, a decision that replaced an older decision, an
   * instruction intentionally withdrawn. The old content is not erased — that
   * is the point of superseding rather than editing: the repository keeps what
   * was true, and says when it stopped being true and what replaced it.
   *
   * One commit and two revisions, so a half-applied supersession cannot exist
   * (`KNOWLEDGE_LIFECYCLE.md` section 5). The relation is recorded once, on the
   * new item, and written twice: the new file carries it in `relations`, the
   * old file carries `superseded_by`. ADR 0015 records why.
   */
  async supersede(actor: ActorContext, input: SupersedeInput): Promise<SupersedeResult> {
    // Shape, not state: these two read nothing, so they answer before the
    // workspace lock is worth taking.
    if ((input.newItem === undefined) === (input.existingItem === undefined)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'a supersession names either a new item to write or an item that already exists, not both and not neither',
      );
    }
    if (input.existingItem && input.existingItem.itemId === input.oldItemId) {
      throw new DomainError('VALIDATION_ERROR', 'an item cannot supersede itself');
    }

    // Known without reading anything: a supersession either names the item
    // that takes over or writes a new one.
    const newItemId = input.existingItem?.itemId ?? (newId('kn') as KnowledgeItemId);
    const newRevisionId = newId('rev') as RevisionId;
    const oldRevisionId = newId('rev') as RevisionId;
    let plannedNew: PlannedItem | undefined;
    let plannedOld: PlannedUpdate | undefined;
    // Both read inside the commit step, under the workspace lock, and used by
    // the record step afterwards. See currentFor().
    let superseded: ItemResult | undefined;
    // The replacement, when it is something the workspace already holds. It
    // gets a revision of its own, so rule 6 applies to it too.
    let replacement: ItemResult | null = null;

    return this.o.crossStore.run<SupersedeResult>(actor, {
      type: 'supersede',
      objectIds: { knowledge_item: newItemId, superseded_item: input.oldItemId },
      commit: async (operation) => {
        const old = (superseded = await this.currentFor(
          actor,
          input.oldItemId,
          input.oldBaseRevisionId,
          input.oldBaseContentHash,
          'the item changed since you read it; re-read it before superseding it',
        ));
        if (old.item.status !== 'active') {
          throw new DomainError(
            'VALIDATION_ERROR',
            `an item that is ${old.item.status} cannot be superseded`,
            { objectIds: { knowledge_item: input.oldItemId } },
          );
        }
        if (input.existingItem) {
          replacement = await this.currentFor(
            actor,
            input.existingItem.itemId,
            input.existingItem.baseRevisionId,
            input.existingItem.baseContentHash,
            'the replacing item changed since you read it; re-read it before superseding with it',
          );
          if (replacement.item.status !== 'active') {
            throw new DomainError(
              'VALIDATION_ERROR',
              `an item that is ${replacement.item.status} cannot supersede another`,
              { objectIds: { knowledge_item: replacement.item.id } },
            );
          }
        }

        const body = (input.newItem?.body ?? replacement!.body).trim();
        if (body === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a body');
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          throw new DomainError(
            'VALIDATION_ERROR',
            `the body may not exceed ${MAX_BODY_BYTES} bytes`,
          );
        }
        const title = (input.newItem?.title ?? replacement!.revision.title).trim();
        if (title === '') throw new DomainError('VALIDATION_ERROR', 'an item needs a title');

        const workspace = await this.o.workspaces.findById(actor.workspaceId);
        if (!workspace) throw new DomainError('NOT_FOUND', 'workspace not found');
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.assertRepositoryIsOurs(actor.workspaceId);

        // The instant the changeover happened: the old item stops being true
        // where the new one starts, so both dates are the same date.
        const changeover = input.validUntil ?? now.toISOString();

        const tree = await this.o.categories.list(actor.workspaceId, { includeArchived: true });
        const chosen = this.resolveCategories(
          tree,
          input.newItem?.categories ?? replacement?.categories ?? [],
        );
        // An item that already exists stays where it is; a new one is placed
        // by its primary category, exactly as a create places it.
        const slug = replacement
          ? replacement.item.slug
          : this.parseSlug(
              this.o.uniqueSlug(
                input.newItem?.slug ?? this.o.slugifyTitle(title),
                new Set(
                  await this.o.items.slugsInDirectory(
                    actor.workspaceId,
                    chosen[0] ? `knowledge/${chosen[0].path}` : UNCATEGORISED_DIRECTORY,
                  ),
                ),
              ),
            );
        const newPath = replacement
          ? replacement.item.markdownPath
          : `${chosen[0] ? `knowledge/${chosen[0].path}` : UNCATEGORISED_DIRECTORY}/${slug}.md`;

        const relations: FrontmatterRelation[] = [
          ...(input.newItem?.relations ?? replacement?.revision.frontmatter.relations ?? []).filter(
            (r) => r.target !== input.oldItemId,
          ),
          { type: 'supersedes', target: input.oldItemId },
        ];
        const newFrontmatter: Frontmatter = replacement
          ? ({
              ...replacement.revision.frontmatter,
              // What changes on an item that already exists: when it took
              // over, and what it took over from. Its own text is its own.
              valid_from: changeover,
              relations,
              review:
                input.review ??
                (actor.actorType === 'human'
                  ? 'human_reviewed'
                  : replacement.revision.frontmatter.review),
              updated_at: now.toISOString(),
            } as Frontmatter)
          : ({
              id: newItemId,
              title,
              type: input.newItem!.type,
              status: 'active',
              language: input.newItem!.language ?? workspace.defaultLanguage,
              categories: chosen.map((c) => c.path),
              tags: tagList(input.newItem!.tags ?? []),
              review:
                input.review ?? (actor.actorType === 'human' ? 'human_reviewed' : 'unreviewed'),
              evidence: evidenceFrom(input.newItem!.sources ?? []),
              disputed: false,
              valid_from: changeover,
              valid_until: null,
              observed_at: input.newItem!.observedAt ?? null,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
              sources: [...(input.newItem!.sources ?? [])],
              relations,
              ...(input.newItem!.external ? { external: input.newItem!.external } : {}),
            } as Frontmatter);
        await this.assertRelationTargets(actor.workspaceId, newItemId, relations);

        // The old item keeps its text. What changes is that it is no longer
        // current, when it stopped being current, and what replaced it.
        const oldFrontmatter: Frontmatter = {
          ...old.revision.frontmatter,
          status: 'superseded',
          valid_until: changeover,
          superseded_by: newItemId,
          updated_at: now.toISOString(),
        } as Frontmatter;

        const newRendered = this.o.renderItem({ frontmatter: newFrontmatter, body });
        const oldRendered = this.o.renderItem({
          frontmatter: oldFrontmatter,
          body: old.body,
        });
        await this.o.git.write(actor.workspaceId, [
          { path: newPath, content: newRendered },
          { path: old.item.markdownPath, content: oldRendered },
        ]);
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: [newPath, old.item.markdownPath],
          subject: `supersede(${newFrontmatter.type}): ${title}`,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            ...(input.proposalId
              ? ([['Knoverge-Proposal', input.proposalId]] as [string, string][])
              : []),
            // One per revision the commit produced, which is what recovery
            // reads: the new item was created, the old one was superseded.
            [
              'Knoverge-Change',
              `${newItemId}@${newRevisionId} ${replacement ? 'supersede' : 'create'}`,
            ],
            ['Knoverge-Change', `${input.oldItemId}@${oldRevisionId} superseded_by`],
          ],
          author,
          at: now,
          ...(input.reason ? { body: input.reason } : {}),
        });
        if (commitHash === null) {
          throw new DomainError('INTERNAL_ERROR', 'the supersession produced no commit');
        }
        plannedNew = {
          frontmatter: newFrontmatter,
          body,
          slug,
          markdownPath: newPath,
          chosen,
          rendered: newRendered,
          now,
          commitHash,
          kind: replacement ? 'supersede' : 'create',
        };
        plannedOld = {
          frontmatter: oldFrontmatter,
          body: old.body,
          markdownPath: old.item.markdownPath,
          chosen: [],
          rendered: oldRendered,
          now,
          commitHash,
          kind: 'superseded_by',
        };
        return {
          commitHash,
          // Both items, because recovery reads this to know which items the
          // commit was allowed to touch, and it touched two.
          objectIds: {
            knowledge_item: newItemId,
            superseded_item: input.oldItemId,
            path: newPath,
          },
        };
      },
      record: async (tx, operation) => {
        if (!plannedNew || !plannedOld || !superseded) {
          throw new DomainError('INTERNAL_ERROR', 'the supersession was never planned');
        }
        const pNew = plannedNew;
        const pOld = plannedOld;
        const old = superseded;

        const newRevision = this.revisionOf(
          actor,
          newItemId,
          newRevisionId,
          replacement ? replacement.revision.revisionNumber + 1 : 1,
          pNew,
          operation.id,
        );
        if (replacement) {
          await this.o.items.update(tx, newItemId, {
            currentRevisionId: newRevisionId,
            reviewState: pNew.frontmatter.review,
            validFrom: pNew.frontmatter.valid_from ? new Date(pNew.frontmatter.valid_from) : null,
            updatedAt: pNew.now,
          });
          await this.o.revisions.insert(tx, newRevision);
        } else {
          await this.o.items.insert(tx, {
            id: newItemId,
            workspaceId: actor.workspaceId,
            slug: pNew.slug,
            markdownPath: pNew.markdownPath,
            type: pNew.frontmatter.type,
            status: 'active',
            language: pNew.frontmatter.language,
            currentRevisionId: newRevisionId,
            reviewState: pNew.frontmatter.review,
            evidenceState: pNew.frontmatter.evidence,
            disputed: false,
            validFrom: pNew.frontmatter.valid_from ? new Date(pNew.frontmatter.valid_from) : null,
            validUntil: null,
            observedAt: pNew.frontmatter.observed_at
              ? new Date(pNew.frontmatter.observed_at)
              : null,
            createdByActorId: actor.actorId,
            createdAt: pNew.now,
            updatedAt: pNew.now,
          } as KnowledgeItemRecord);
          await this.o.revisions.insert(tx, newRevision);
          await this.o.items.setCategories(
            tx,
            newItemId,
            pNew.chosen.map<ItemCategoryRecord>((category, index) => ({
              knowledgeItemId: newItemId,
              categoryId: category.id,
              isPrimary: index === 0,
              position: index,
            })),
          );
          await this.o.items.setTags(tx, actor.workspaceId, newItemId, pNew.frontmatter.tags);
        }
        await this.writeSources(
          tx,
          actor.workspaceId,
          newRevisionId,
          pNew.frontmatter.sources,
          pNew.now,
        );
        // One relation row, on the new item, pointing at what it replaced.
        await this.writeRelations(tx, actor, newItemId, pNew.frontmatter.relations, pNew.now);
        await this.index(
          tx,
          actor.workspaceId,
          newItemId,
          newRevisionId,
          pNew.frontmatter,
          pNew.body,
          pNew.now,
        );
        // The superseded item stays findable: it is history, not a mistake,
        // and a search filtered to active items already leaves it out.
        await this.index(
          tx,
          actor.workspaceId,
          input.oldItemId,
          oldRevisionId,
          pOld.frontmatter,
          pOld.body,
          pOld.now,
        );

        const oldCategoryIds = (
          await this.o.items.categoriesOf(actor.workspaceId, [input.oldItemId])
        ).map((row) => row.categoryId as string);
        const oldRevision = this.revisionOf(
          actor,
          input.oldItemId,
          oldRevisionId,
          old.revision.revisionNumber + 1,
          pOld,
          operation.id,
        );
        await this.o.revisions.insert(tx, oldRevision);
        await this.o.items.update(tx, input.oldItemId, {
          status: 'superseded',
          currentRevisionId: oldRevisionId,
          validUntil: pOld.frontmatter.valid_until ? new Date(pOld.frontmatter.valid_until) : null,
          updatedAt: pOld.now,
        });

        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          // Created when it was written now, superseded when an item the
          // workspace already had took over.
          eventType: replacement ? 'knowledge.superseded' : 'knowledge.created',
          objectType: 'knowledge_item',
          objectId: newItemId,
          categoryIds: pNew.chosen.map((c) => c.id),
          metadata: {
            revision: newRevisionId,
            content_hash: newRevision.contentHash,
            frontmatter_hash: newRevision.frontmatterHash,
            git_commit: pNew.commitHash,
            item_type: pNew.frontmatter.type,
            supersedes: input.oldItemId,
            categories_before: [],
            categories_after: pNew.chosen.map((c) => c.id),
          },
        });
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.superseded',
          objectType: 'knowledge_item',
          objectId: input.oldItemId,
          categoryIds: oldCategoryIds,
          metadata: {
            revision: oldRevisionId,
            before_revision: old.revision.id,
            before_hash: old.revision.contentHash,
            content_hash: oldRevision.contentHash,
            frontmatter_hash: oldRevision.frontmatterHash,
            git_commit: pOld.commitHash,
            superseded_by: newItemId,
            categories_before: oldCategoryIds,
            categories_after: oldCategoryIds,
          },
        });

        return {
          new: {
            item: (await this.o.items.findById(actor.workspaceId, newItemId, tx)) as never,
            revision: newRevision,
            categories: pNew.frontmatter.categories,
            tags: pNew.frontmatter.tags,
            body: pNew.body,
          },
          old: {
            item: (await this.o.items.findById(actor.workspaceId, input.oldItemId, tx)) as never,
            revision: oldRevision,
            categories: old.categories,
            tags: old.tags,
            body: pOld.body,
          },
        };
      },
    });
  }

  /** Brings back an item a delete removed, at the content it had. */
  async restore(actor: ActorContext, itemId: KnowledgeItemId): Promise<ItemResult> {
    // Every read is inside the loader, which the commit step calls under the
    // workspace lock: two restores of the same item that both read "deleted"
    // would both claim the next revision number, and the second would land a
    // commit PostgreSQL then refuses. See currentFor().
    return this.reinstate(actor, itemId, async () => {
      const item = await this.o.items.findById(actor.workspaceId, itemId);
      if (!item) {
        throw new DomainError('NOT_FOUND', 'knowledge item not found', {
          objectIds: { knowledge_item: itemId },
        });
      }
      if (item.status !== 'deleted') {
        throw new DomainError('VALIDATION_ERROR', 'this item is not deleted');
      }
      const deleteRevision = item.currentRevisionId
        ? await this.o.revisions.findById(actor.workspaceId, item.currentRevisionId)
        : null;
      if (!deleteRevision) {
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
      return { item, deleteRevision, previous, body: this.o.parseItem(file).body };
    });
  }

  /** One item with its body, read from the file that is canonical. */
  /**
   * One item, at its current revision or at one it had.
   *
   * A past revision is read from the commit that wrote it, because that is
   * where it is: PostgreSQL keeps the frontmatter of every revision and the
   * text of none. Reading the current one is a plain file read.
   */
  async get(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    atRevision?: RevisionId | undefined,
  ): Promise<ItemResult> {
    const item = await this.o.items.findById(actor.workspaceId, itemId);
    if (!item || item.deletedAt) {
      throw new DomainError('NOT_FOUND', 'knowledge item not found', {
        objectIds: { knowledge_item: itemId },
      });
    }
    const wanted = atRevision ?? item.currentRevisionId;
    const revision = wanted
      ? await this.o.revisions.findById(actor.workspaceId, wanted as RevisionId)
      : null;
    if (!revision) {
      throw new DomainError(
        atRevision ? 'NOT_FOUND' : 'INTERNAL_ERROR',
        atRevision ? 'no such revision of this item' : 'the item has no current revision',
        { objectIds: { knowledge_item: itemId, ...(atRevision ? { revision: atRevision } : {}) } },
      );
    }
    if (revision.knowledgeItemId !== itemId) {
      throw new DomainError('VALIDATION_ERROR', 'that revision belongs to a different item', {
        objectIds: { knowledge_item: itemId, revision: revision.id },
      });
    }
    const file =
      atRevision && atRevision !== item.currentRevisionId
        ? await this.o.git.readAt(actor.workspaceId, revision.gitCommitHash, revision.markdownPath)
        : await this.o.git.read(actor.workspaceId, item.markdownPath);
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
    // One query for the page's titles, not one per item: a list of fifty was
    // fifty round trips to draw one screen.
    const revisionIds = items.map((i) => i.currentRevisionId).filter((id) => id !== null);
    const current = new Map(
      (await this.o.revisions.findManyByIds(actor.workspaceId, revisionIds)).map((r) => [r.id, r]),
    );
    return items.map((item) => {
      const revision = item.currentRevisionId ? current.get(item.currentRevisionId) : undefined;
      return {
        item,
        title: revision?.title ?? '',
        revisionNumber: revision?.revisionNumber ?? 1,
        categories: categories.get(item.id) ?? [],
        tags: tags.get(item.id) ?? [],
      };
    });
  }

  /**
   * The sizes of the piles the list offers as quick views.
   *
   * The same permission the list needs and no narrower: these count what that
   * caller would see if they asked for all of it.
   */
  pileSizes(actor: ActorContext): Promise<KnowledgePiles> {
    return this.o.items.pileSizes(actor.workspaceId);
  }

  /** The commit and the rows that take an item out of the working tree. */
  private async retire(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    /** Reads and checks the item under the lock, never before it. */
    load: () => Promise<ItemResult>,
    kind: 'delete',
    proposalId?: ProposalId | undefined,
    reason?: string | undefined,
  ): Promise<ItemResult> {
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedUpdate | undefined;
    let current: ItemResult | undefined;
    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'delete',
      objectIds: { knowledge_item: itemId },
      commit: async (operation) => {
        const item = (current = await load());
        const author = await this.authorOf(actor);
        const now = this.clock.now();
        await this.assertRepositoryIsOurs(actor.workspaceId);
        const frontmatter: Frontmatter = {
          ...item.revision.frontmatter,
          status: 'deleted',
          updated_at: now.toISOString(),
        } as Frontmatter;
        await this.o.git.remove(actor.workspaceId, [item.item.markdownPath]);
        const commitHash = await this.o.git.commit(actor.workspaceId, {
          paths: [item.item.markdownPath],
          subject: `delete(${frontmatter.type}): ${item.revision.title}`,
          trailers: [
            ['Knoverge-Operation', operation.id],
            ['Knoverge-Workspace', actor.workspaceId],
            ['Knoverge-Actor', actor.actorId],
            ...(actor.agentId ? ([['Knoverge-Agent', actor.agentId]] as [string, string][]) : []),
            ...(proposalId ? ([['Knoverge-Proposal', proposalId]] as [string, string][]) : []),
            ['Knoverge-Change', `${itemId}@${revisionId} ${kind}`],
          ],
          author,
          at: now,
          ...(reason ? { body: reason } : {}),
        });
        if (commitHash === null) {
          throw new DomainError('INTERNAL_ERROR', 'the file was already gone from the tree');
        }
        planned = {
          frontmatter,
          body: item.body,
          markdownPath: item.item.markdownPath,
          chosen: [],
          // The file is gone, so the frontmatter hash is taken from what the
          // delete revision records rather than from a file on disk.
          rendered: this.o.renderItem({ frontmatter, body: item.body }),
          now,
          commitHash,
          kind,
          ...(reason ? { reason } : {}),
        };
        return { commitHash, objectIds: { knowledge_item: itemId } };
      },
      record: async (tx, operation) => {
        if (!planned || !current) {
          throw new DomainError('INTERNAL_ERROR', 'the delete was never planned');
        }
        const p = planned;
        const item = current;
        const revision = this.revisionOf(
          actor,
          itemId,
          revisionId,
          item.revision.revisionNumber + 1,
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
        await this.index(tx, actor.workspaceId, itemId, revisionId, p.frontmatter, '', p.now);
        const gone = (await this.o.items.categoriesOf(actor.workspaceId, [itemId])).map(
          (row) => row.categoryId as string,
        );
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.deleted',
          objectType: 'knowledge_item',
          objectId: itemId,
          // Where it was, so the change feed reaches whoever could see it.
          categoryIds: gone,
          metadata: {
            revision: revisionId,
            before_revision: item.revision.id,
            content_hash: revision.contentHash,
            frontmatter_hash: revision.frontmatterHash,
            git_commit: p.commitHash,
            categories_before: gone,
            categories_after: [],
          },
        });
        return { ...item, revision, item: { ...item.item, status: 'deleted' } };
      },
    });
  }

  /** The commit and the rows that put a deleted item back. */
  private async reinstate(
    actor: ActorContext,
    itemId: KnowledgeItemId,
    /** Reads and checks the item under the lock, never before it. */
    load: () => Promise<RestoreSource>,
  ): Promise<ItemResult> {
    const revisionId = newId('rev') as RevisionId;
    let planned: PlannedUpdate | undefined;
    let source: RestoreSource | undefined;
    return this.o.crossStore.run<ItemResult>(actor, {
      type: 'restore',
      objectIds: { knowledge_item: itemId },
      commit: async (operation) => {
        const { item, previous, body } = (source = await load());
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
        if (!planned || !source) {
          throw new DomainError('INTERNAL_ERROR', 'the restore was never planned');
        }
        const p = planned;
        const { item, deleteRevision, previous } = source;
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
        await this.index(tx, actor.workspaceId, item.id, revisionId, p.frontmatter, p.body, p.now);
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.restored',
          objectType: 'knowledge_item',
          objectId: item.id,
          categoryIds: p.chosen.map((c) => c.id),
          metadata: {
            revision: revisionId,
            restored_from: previous.id,
            content_hash: revision.contentHash,
            frontmatter_hash: revision.frontmatterHash,
            git_commit: p.commitHash,
            categories_before: [],
            categories_after: p.chosen.map((c) => c.id),
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

  /**
   * Rebuilds the lexical index for a whole workspace from the files.
   *
   * The index is a projection, so it is never restored — it is rebuilt. A
   * PostgreSQL backup older than the repository, or a change to how text is
   * tokenised, both end here. Git is read for every item, because Git is
   * where the knowledge is; PostgreSQL only says which items there are.
   */
  async reindex(
    workspaceId: WorkspaceId,
    options: { onlyMissing?: boolean } = {},
  ): Promise<{ indexed: number; missing: number }> {
    // `onlyMissing` is what startup uses: the whole workspace is rebuilt when
    // an operator asks for it, and on every boot only what the index does not
    // already hold. A feature that ships an index and never fills it for the
    // knowledge already there is a feature that answers nothing, silently.
    const already = options.onlyMissing
      ? await this.o.search.indexedIds(workspaceId)
      : new Set<string>();
    let indexed = 0;
    let missing = 0;
    let after: KnowledgeItemId | undefined;
    for (;;) {
      const page = await this.o.items.list(workspaceId, {
        limit: 200,
        ...(after ? { after } : {}),
      });
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      for (const item of page) {
        if (item.status === 'deleted') {
          if (!options.onlyMissing) await this.o.uow.run((tx) => this.o.search.remove(tx, item.id));
          continue;
        }
        if (already.has(item.id)) continue;
        const file = await this.o.git.read(workspaceId, item.markdownPath);
        if (file === null) {
          // The database names a file the repository does not have. Saying so
          // beats writing an empty index row that would look like an item
          // with no text in it.
          missing += 1;
          continue;
        }
        const parsed = this.o.parseItem(file);
        await this.o.uow.run((tx) =>
          this.o.search.upsert(tx, {
            knowledgeItemId: item.id,
            workspaceId,
            revisionId: item.currentRevisionId as RevisionId,
            language: parsed.frontmatter.language,
            title: parsed.frontmatter.title,
            chunks: chunksFor(parsed.body, parsed.frontmatter.title),
            updatedAt: item.updatedAt,
          }),
        );
        indexed += 1;
      }
    }
    return { indexed, missing };
  }

  /**
   * The lexical index for one revision, written with it.
   *
   * `ARCHITECTURE.md` describes projections as jobs, which is right for an
   * embedding: that needs a provider and can fail. A tsvector needs nothing
   * but the text, so writing it in the same transaction costs nothing and
   * means a search never disagrees with what was just written.
   */
  private async index(
    tx: Tx,
    workspaceId: WorkspaceId,
    itemId: KnowledgeItemId,
    revisionId: RevisionId,
    frontmatter: Frontmatter,
    body: string,
    at: Date,
  ): Promise<void> {
    if (frontmatter.status === 'deleted') {
      // Out of the index with the file: an item nobody can read should not be
      // findable. The history keeps it, and restoring puts it back.
      await this.o.search.remove(tx, itemId);
      return;
    }
    await this.o.search.upsert(tx, {
      knowledgeItemId: itemId,
      workspaceId,
      revisionId,
      language: frontmatter.language,
      title: frontmatter.title,
      chunks: chunksFor(body, frontmatter.title),
      updatedAt: at,
    });
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
      /** Why, in whoever's own words. Absent when nobody said. */
      reason?: string | undefined;
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
      reason: planned.reason ?? null,
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
    const parsed = ItemSlug.safeParse(slug);
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

/** What a restore needs, read under the lock rather than before it. */
interface RestoreSource {
  item: KnowledgeItemRecord;
  /** The revision that removed the file; the new one follows it. */
  deleteRevision: RevisionRecord;
  /** The revision before that, whose commit still holds the text. */
  previous: RevisionRecord;
  body: string;
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
  /** Why, in whoever's own words. Absent when nobody said. */
  reason?: string | undefined;
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
  /** `create`, unless a supersession gave an existing item a new revision. */
  kind?: ChangeKind;
}
