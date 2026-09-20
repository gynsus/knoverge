import type {
  ChangeKind,
  Frontmatter,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { OperationRecord } from '../operations/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { GitStore } from '../ports/git-store.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type { CategoryRepository } from '../taxonomy/repository.ts';
import type {
  ItemCategoryRecord,
  KnowledgeItemRecord,
  KnowledgeRepository,
  RevisionRecord,
  RevisionRepository,
} from './repository.ts';

/** `Knoverge-Change: kn_...@rev_... <kind>` */
const CHANGE = /^(kn_[0-9A-HJKMNP-TV-Z]{26})@(rev_[0-9A-HJKMNP-TV-Z]{26})\s+([a-z_]+)$/;

export interface KnowledgeRecoveryOptions {
  uow: UnitOfWork;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  categories: CategoryRepository;
  ledger: EventLedger;
  git: GitStore;
  parseItem: (text: string) => { frontmatter: Frontmatter; body: string };
  contentHash: (title: string, body: string) => string;
  frontmatterHash: (yaml: string) => string;
  clock?: Clock;
}

/**
 * Finishes the PostgreSQL side of a knowledge write that reached Git and no
 * further.
 *
 * The commit carries everything needed. `Knoverge-Change` names the item, the
 * revision and what happened; the file at that commit carries the whole state
 * of the item, because the frontmatter is the canonical record rather than a
 * summary of one. The operation row carries the request context the trailers
 * do not — the request id, the session, the client — which is why it stores
 * them (ADR 0012).
 *
 * Nothing here re-derives a decision. The commit already decided; this only
 * writes down what it decided.
 */
export class KnowledgeRecovery {
  private readonly o: KnowledgeRecoveryOptions;
  private readonly clock: Clock;

  constructor(options: KnowledgeRecoveryOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /** Whether this operation is one this can finish. */
  handles(operation: OperationRecord): boolean {
    return typeof operation.objectIds['knowledge_item'] === 'string';
  }

  /**
   * Returns false when it cannot finish the operation, which leaves it for an
   * operator rather than guessing. A half-written recovery is worse than an
   * unresolved one: the workspace stays closed either way, and a guess makes
   * the disagreement harder to see.
   */
  async complete(operation: OperationRecord): Promise<boolean> {
    const commitHash = operation.gitCommitHash;
    if (!commitHash || !this.handles(operation)) return false;

    const trailers = await this.o.git.trailersOf(operation.workspaceId, commitHash);
    const change = trailers.find(([name]) => name === 'Knoverge-Change')?.[1];
    const match = change ? CHANGE.exec(change) : null;
    if (!match) return false;
    const [, itemId, revisionId, kind] = match as unknown as [
      string,
      KnowledgeItemId,
      RevisionId,
      ChangeKind,
    ];
    // The trailer and the row must agree. If they do not, this is not the
    // commit this operation made, and writing its contents down would attach
    // one operation's work to another's record.
    if (operation.objectIds['knowledge_item'] !== itemId) return false;

    // Already done: a recovery that ran twice must not write a second revision.
    if (await this.o.revisions.findById(operation.workspaceId, revisionId)) return true;

    const existing = await this.o.items.findById(operation.workspaceId, itemId);
    const path =
      typeof operation.objectIds['path'] === 'string'
        ? operation.objectIds['path']
        : (existing?.markdownPath ?? null);
    if (!path) return false;

    const actor = this.actorOf(operation);
    const now = this.clock.now();

    if (kind === 'delete') {
      if (!existing) return false;
      const previous = await this.o.revisions.findById(
        operation.workspaceId,
        existing.currentRevisionId as RevisionId,
      );
      if (!previous) return false;
      const frontmatter = { ...previous.frontmatter, status: 'deleted' } as Frontmatter;
      await this.write(operation, actor, {
        itemId,
        revisionId,
        kind,
        frontmatter,
        body: '',
        path: previous.markdownPath,
        revisionNumber: previous.revisionNumber + 1,
        commitHash,
        now,
        existing,
        categories: [],
      });
      return true;
    }

    const file = await this.o.git.readAt(operation.workspaceId, commitHash, path);
    if (file === null) return false;
    const parsed = this.o.parseItem(file);
    if (parsed.frontmatter.id !== itemId) return false;

    const tree = await this.o.categories.list(operation.workspaceId, { includeArchived: true });
    const categories = parsed.frontmatter.categories.map((wanted) =>
      tree.find((c) => c.path === wanted),
    );
    // A category the file names and the database does not have means the two
    // stores disagree about more than this one operation.
    if (categories.some((c) => c === undefined)) return false;

    const previousNumber = existing?.currentRevisionId
      ? ((await this.o.revisions.findById(operation.workspaceId, existing.currentRevisionId))
          ?.revisionNumber ?? 0)
      : 0;

    await this.write(operation, actor, {
      itemId,
      revisionId,
      kind,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      path,
      revisionNumber: previousNumber + 1,
      commitHash,
      now,
      existing,
      categories: categories.map((c, index) => ({
        knowledgeItemId: itemId,
        categoryId: c!.id,
        isPrimary: index === 0,
        position: index,
      })),
    });
    return true;
  }

  private async write(
    operation: OperationRecord,
    actor: ActorContext,
    plan: {
      itemId: KnowledgeItemId;
      revisionId: RevisionId;
      kind: ChangeKind;
      frontmatter: Frontmatter;
      body: string;
      path: string;
      revisionNumber: number;
      commitHash: string;
      now: Date;
      existing: KnowledgeItemRecord | null;
      categories: ItemCategoryRecord[];
    },
  ): Promise<void> {
    const f = plan.frontmatter;
    const revision: RevisionRecord = {
      id: plan.revisionId,
      knowledgeItemId: plan.itemId,
      workspaceId: operation.workspaceId,
      revisionNumber: plan.revisionNumber,
      contentHash: this.o.contentHash(f.title, plan.body),
      frontmatterHash: this.o.frontmatterHash(JSON.stringify(f)),
      gitCommitHash: plan.commitHash,
      title: f.title,
      markdownPath: plan.path,
      frontmatter: f,
      changeKind: plan.kind,
      createdByActorId: operation.actorId,
      createdAt: plan.now,
      operationId: operation.id,
    };
    await this.o.uow.run(async (tx: Tx) => {
      if (!plan.existing) {
        await this.o.items.insert(tx, {
          id: plan.itemId,
          workspaceId: operation.workspaceId,
          slug: plan.path.slice(plan.path.lastIndexOf('/') + 1, -'.md'.length),
          markdownPath: plan.path,
          type: f.type,
          status: f.status,
          language: f.language,
          currentRevisionId: plan.revisionId,
          reviewState: f.review,
          evidenceState: f.evidence,
          disputed: f.disputed,
          validFrom: f.valid_from ? new Date(f.valid_from) : null,
          validUntil: f.valid_until ? new Date(f.valid_until) : null,
          observedAt: f.observed_at ? new Date(f.observed_at) : null,
          sourceSystem: f.external?.source_system ?? null,
          externalKey: f.external?.external_key ?? null,
          createdByActorId: operation.actorId,
          createdAt: plan.now,
          updatedAt: plan.now,
          deletedAt: null,
        });
      } else {
        await this.o.items.update(tx, plan.itemId, {
          markdownPath: plan.path,
          status: f.status,
          language: f.language,
          currentRevisionId: plan.revisionId,
          reviewState: f.review,
          validFrom: f.valid_from ? new Date(f.valid_from) : null,
          validUntil: f.valid_until ? new Date(f.valid_until) : null,
          observedAt: f.observed_at ? new Date(f.observed_at) : null,
          updatedAt: plan.now,
          deletedAt: f.status === 'deleted' ? plan.now : null,
        });
      }
      await this.o.revisions.insert(tx, revision);
      if (plan.kind !== 'delete') {
        await this.o.items.setCategories(tx, plan.itemId, plan.categories);
        await this.o.items.setTags(tx, operation.workspaceId, plan.itemId, f.tags);
      }
      await this.o.ledger.append(tx, operation.workspaceId, actor, {
        eventType: eventFor(plan.kind),
        objectType: 'knowledge_item',
        objectId: plan.itemId,
        categoryIds: plan.categories.map((c) => c.categoryId),
        metadata: {
          revision: plan.revisionId,
          content_hash: revision.contentHash,
          git_commit: plan.commitHash,
          change_kind: plan.kind,
          // So the feed shows this was written by recovery rather than by the
          // request that started it, which never finished.
          recovered: true,
        },
      });
    });
  }

  /**
   * The actor context the original request had, rebuilt from the row.
   *
   * Rule 3 wants the request, session, client and model on every material
   * write. The commit trailers carry none of them, which is why the operation
   * row does — a recovered event records exactly what an ordinary one would.
   */
  private actorOf(operation: OperationRecord): ActorContext {
    return {
      workspaceId: operation.workspaceId as WorkspaceId,
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
  kind: ChangeKind,
):
  | 'knowledge.created'
  | 'knowledge.updated'
  | 'knowledge.moved'
  | 'knowledge.deleted'
  | 'knowledge.restored' {
  switch (kind) {
    case 'create':
      return 'knowledge.created';
    case 'move':
      return 'knowledge.moved';
    case 'delete':
      return 'knowledge.deleted';
    case 'restore':
      return 'knowledge.restored';
    default:
      return 'knowledge.updated';
  }
}

/** Raised when a recovery is asked for something it was not given. */
export function cannotRecover(operationId: string): DomainError {
  return new DomainError('INTERNAL_ERROR', `operation ${operationId} cannot be recovered`, {
    objectIds: { operation: operationId },
  });
}
