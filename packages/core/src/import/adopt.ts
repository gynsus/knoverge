import type { Frontmatter, KnowledgeItemId, RevisionId, WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import { chunksFor } from '../knowledge/chunks.ts';
import type {
  KnowledgeRepository,
  RelationRepository,
  RevisionRepository,
  SourceRepository,
  SummaryRepository,
} from '../knowledge/repository.ts';
import { recordSources } from '../knowledge/sources.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { OperationRepository } from '../operations/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { GitStore } from '../ports/git-store.ts';
import type { SearchRepository } from '../search/repository.ts';
import type { CategoryRepository } from '../taxonomy/repository.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';

export interface AdoptServiceOptions {
  uow: UnitOfWork;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  categories: CategoryRepository;
  relations: RelationRepository;
  sources: SourceRepository;
  summaries: SummaryRepository;
  search: SearchRepository;
  operations: OperationRepository;
  ledger: EventLedger;
  git: GitStore;
  parseItem: (text: string) => { frontmatter: Frontmatter; body: string };
  contentHash: (title: string, body: string) => string;
  frontmatterHash: (yaml: string) => string;
  clock?: Clock;
}

export interface AdoptOutcome {
  /** Commits the database had never heard of. */
  commits: number;
  created: number;
  updated: number;
  /** Files that could not be adopted, and why each could not. */
  skipped: { path: string; why: string }[];
}

/**
 * Taking in what somebody committed to the repository by hand.
 *
 * Rule 1 says the canonical knowledge is Markdown in a Git repository, readable
 * and editable without this product, and people take that literally — which is
 * the point. Until this existed the answer to a commit made by hand was a
 * finding: `integrity check` said `head_unknown` and stopped, leaving a
 * workspace the product called wrong and the person called finished.
 *
 * So the database catches up instead. ADR 0037 records what that means, and the
 * hard part is that an external commit carries no trailers: the file itself is
 * what says which item it is, through the id in its frontmatter.
 */
export class AdoptService {
  private readonly o: AdoptServiceOptions;
  private readonly clock: Clock;

  constructor(options: AdoptServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async run(workspaceId: WorkspaceId, by: ActorContext): Promise<AdoptOutcome> {
    const known = await this.o.revisions.latestCommit(workspaceId);
    // A repository whose history no longer contains what this workspace was
    // written from is not this workspace's history. Adopting on top of it would
    // attach these records to commits that no longer say what they said.
    if (known !== null && !(await this.o.git.hasCommit(workspaceId, known))) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `the newest commit this workspace was written from (${known}) is not in the repository's history; somebody rewrote it`,
        { objectIds: { commit: known } },
      );
    }

    // The whole history, filtered by what the database has heard of — not a
    // range after the newest known commit. A commit made by hand can sit
    // between two the product made, and a range would skip it entirely.
    const seen = await this.o.revisions.commitsKnown(workspaceId);
    const commits = (await this.o.git.commits(workspaceId)).filter((commit) => !seen.has(commit));
    const outcome: AdoptOutcome = { commits: 0, created: 0, updated: 0, skipped: [] };
    if (commits.length === 0) return outcome;

    const operationId = newId('op');
    const now = this.clock.now();
    await this.o.uow.run((tx) =>
      this.o.operations.insert(tx, {
        id: operationId,
        workspaceId,
        actorId: by.actorId,
        operationType: 'import',
        state: 'db_committed',
        objectIds: {},
        intendedPayloadHash: null,
        gitCommitHash: commits.at(-1) as string,
        taxonomyVersion: null,
        requestId: by.requestId,
        sessionId: null,
        agentId: null,
        client: by.client ?? null,
        provider: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        error: null,
      }),
    );

    for (const commit of commits) {
      const changed = (await this.o.git.changedFiles(workspaceId, commit)).filter(
        (path) => path.startsWith('knowledge/') && path.endsWith('.md'),
      );
      // Counted only when it held knowledge. The commit that created the
      // repository touched a README and nothing else, and every workspace has
      // one — reporting it as adopted would say something happened that did
      // not.
      if (changed.length === 0) continue;
      outcome.commits += 1;
      for (const path of changed) {
        const written = await this.one(workspaceId, by, commit, path, operationId);
        if (written === 'created') outcome.created += 1;
        else if (written === 'updated') outcome.updated += 1;
        else outcome.skipped.push({ path, why: written });
      }
    }
    return outcome;
  }

  /** One file at one commit: created, updated, or the reason it was neither. */
  private async one(
    workspaceId: WorkspaceId,
    by: ActorContext,
    commit: string,
    path: string,
    operationId: string,
  ): Promise<'created' | 'updated' | string> {
    const file = await this.o.git.readAt(workspaceId, commit, path);
    // Gone at this commit: somebody deleted the file. Recorded as nothing,
    // because a deletion by hand is a statement this cannot read — the file
    // that would say what was deleted is exactly what is not there.
    if (file === null) return 'the file is not in this commit';

    let parsed: { frontmatter: Frontmatter; body: string };
    try {
      parsed = this.o.parseItem(file);
    } catch (error) {
      return `the frontmatter could not be read: ${(error as Error).message}`;
    }
    const f = parsed.frontmatter;
    const itemId = f.id as KnowledgeItemId;
    const existing = await this.o.items.findById(workspaceId, itemId);
    const now = this.clock.now();
    const revisionId = newId('rev') as RevisionId;

    const tree = await this.o.categories.list(workspaceId, { includeArchived: true });
    const categories = f.categories
      .map((wanted, position) => {
        const found = tree.find((c) => c.path === wanted);
        return found
          ? { knowledgeItemId: itemId, categoryId: found.id, isPrimary: position === 0, position }
          : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const previous = existing?.currentRevisionId
      ? await this.o.revisions.findById(workspaceId, existing.currentRevisionId as RevisionId)
      : null;
    const contentHash = this.o.contentHash(f.title, parsed.body);
    // Nothing changed about the knowledge or its metadata, so there is nothing
    // to record: a commit that only moved a file the product already knows
    // about would otherwise produce a revision that says nothing happened.
    const frontmatterHash = this.o.frontmatterHash(JSON.stringify(f));
    if (
      previous &&
      previous.contentHash === contentHash &&
      previous.frontmatterHash === frontmatterHash &&
      previous.markdownPath === path
    ) {
      return 'nothing about it changed';
    }

    await this.o.uow.run(async (tx) => {
      const revision = {
        id: revisionId,
        knowledgeItemId: itemId,
        workspaceId,
        revisionNumber: (previous?.revisionNumber ?? 0) + 1,
        contentHash,
        frontmatterHash,
        gitCommitHash: commit,
        title: f.title,
        markdownPath: path,
        frontmatter: f,
        changeKind: existing ? ('update' as const) : ('create' as const),
        createdByActorId: by.actorId,
        createdAt: now,
        operationId,
        // Who made the commit is in the Git author, which the revision keeps by
        // keeping the commit. A reason is free text somebody wrote in a commit
        // message, and reading one out of it would be guessing which line.
        reason: null,
      };
      if (!existing) {
        await this.o.items.insert(tx, {
          id: itemId,
          workspaceId,
          slug: path.slice(path.lastIndexOf('/') + 1, -'.md'.length),
          markdownPath: path,
          type: f.type,
          status: f.status,
          language: f.language,
          currentRevisionId: revisionId,
          reviewState: f.review,
          evidenceState: f.evidence,
          disputed: f.disputed,
          validFrom: f.valid_from ? new Date(f.valid_from) : null,
          validUntil: f.valid_until ? new Date(f.valid_until) : null,
          observedAt: f.observed_at ? new Date(f.observed_at) : null,
          sourceSystem: f.external?.source_system ?? null,
          externalKey: f.external?.external_key ?? null,
          createdByActorId: by.actorId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      } else {
        await this.o.items.update(tx, itemId, {
          markdownPath: path,
          status: f.status,
          language: f.language,
          currentRevisionId: revisionId,
          reviewState: f.review,
          evidenceState: f.evidence,
          disputed: f.disputed,
          validFrom: f.valid_from ? new Date(f.valid_from) : null,
          validUntil: f.valid_until ? new Date(f.valid_until) : null,
          observedAt: f.observed_at ? new Date(f.observed_at) : null,
          updatedAt: now,
          deletedAt: f.status === 'deleted' ? now : null,
        });
      }
      await this.o.revisions.insert(tx, revision);
      await this.o.items.setCategories(tx, itemId, categories);
      await this.o.items.setTags(tx, workspaceId, itemId, f.tags);
      await this.o.search.upsert(tx, {
        knowledgeItemId: itemId,
        workspaceId,
        revisionId,
        language: f.language,
        title: f.title,
        chunks: chunksFor(parsed.body, f.title),
        updatedAt: now,
      });
      await this.o.relations.replaceForItem(
        tx,
        workspaceId,
        itemId,
        f.relations.map((relation) => ({
          relationType: relation.type,
          toItemId: relation.target,
          validFrom: null,
          validUntil: null,
          createdByActorId: by.actorId,
        })),
        now,
      );
      await recordSources(this.o.sources, tx, workspaceId, revisionId, f.sources, now);
      await this.o.summaries.replaceForSummary(
        tx,
        itemId,
        (f.summary_of ?? []).map((ref, position) => {
          const at = ref.lastIndexOf('@');
          return {
            sourceItemId: ref.slice(0, at) as KnowledgeItemId,
            sourceRevisionId: ref.slice(at + 1) as RevisionId,
            position,
          };
        }),
      );
      await this.o.ledger.append(tx, workspaceId, by, {
        eventType: existing ? 'knowledge.updated' : 'knowledge.created',
        objectType: 'knowledge_item',
        objectId: itemId,
        categoryIds: categories.map((c) => c.categoryId),
        afterRevisionId: revisionId,
        afterContentHash: contentHash,
        // So the feed does not read as if somebody used the product: this is
        // the installation noticing what was done to the repository.
        metadata: { git_commit: commit, adopted: true },
      });
    });
    return existing ? 'updated' : 'created';
  }
}
