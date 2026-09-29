import type {
  ActorId,
  ActorType,
  AttachmentId,
  CategoryId,
  CategoryStatus,
  ChangeKind,
  Frontmatter,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import type { AttachmentRepository } from '../attachments/repository.ts';
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
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { SearchRepository } from '../search/repository.ts';
import type {
  AliasRepository,
  CategoryRepository,
  TaxonomyVersionRepository,
} from '../taxonomy/repository.ts';
import type { ActorRepository } from '../workspace/repository.ts';

/** What an export's manifest says, as much of it as an import reads. */
export interface ImportManifest {
  format: string;
  format_version: number;
  workspace: { slug: string; name: string; default_language: string };
  actors: { id: string; type: string; display_name: string }[];
  attachments: {
    id: string;
    filename: string;
    media_type: string;
    size_bytes: number;
    content_hash: string;
    included: boolean;
  }[];
}

export interface ImportServiceOptions {
  uow: UnitOfWork;
  actors: ActorRepository;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  categories: CategoryRepository;
  relations: RelationRepository;
  sources: SourceRepository;
  summaries: SummaryRepository;
  search: SearchRepository;
  operations: OperationRepository;
  attachments: AttachmentRepository;
  aliases: AliasRepository;
  versions: TaxonomyVersionRepository;
  ledger: EventLedger;
  git: GitStore;
  parseItem: (text: string) => { frontmatter: Frontmatter; body: string };
  parseTaxonomy: (text: string) => {
    version: number;
    categories: readonly {
      path: string;
      slug: string;
      name: string;
      status: string;
      description: string | null;
      aliases: string[];
      inclusionGuidance: string[];
      exclusionGuidance: string[];
    }[];
  };
  taxonomyPath: string;
  contentHash: (title: string, body: string) => string;
  frontmatterHash: (yaml: string) => string;
  clock?: Clock;
}

export interface ImportOutcome {
  workspaceId: WorkspaceId;
  /** Commits walked, and what came out of them. */
  commits: number;
  items: number;
  revisions: number;
  actors: number;
  /** Commits whose `Knoverge-Change` named a file the commit does not have. */
  skipped: string[];
}

/** `<item>@<revision> <kind>`, the trailer recovery reads and this one replays. */
const CHANGE = /^(kn_[0-9A-HJKMNP-TV-Z]{26})@(rev_[0-9A-HJKMNP-TV-Z]{26}) ([a-z_]+)$/u;

const FORMAT = 'knoverge-workspace-export';
const SUPPORTED_VERSION = 1;

/**
 * Putting a workspace back from an export.
 *
 * The bundle carries the knowledge and its whole past; this walks that past in
 * the order it happened and writes the rows PostgreSQL answers from. It is the
 * rebuild `db recover` does from a single commit, over every commit.
 *
 * ADR 0035 records the three decisions behind it: the history comes back rather
 * than only the current state; the actors the commits name are recreated and are
 * nobody here; and an import into a workspace that already holds knowledge is
 * refused, because that case is a reconciliation.
 */
export class ImportService {
  private readonly o: ImportServiceOptions;
  private readonly clock: Clock;

  constructor(options: ImportServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Reads the manifest and says whether this is an export this version knows.
   *
   * A number and not a range: meeting a newer shape and guessing which half of
   * it is understood is how half a workspace arrives.
   */
  check(manifest: ImportManifest): void {
    if (manifest.format !== FORMAT) {
      throw new DomainError('VALIDATION_ERROR', 'this directory is not a Knoverge export');
    }
    if (manifest.format_version !== SUPPORTED_VERSION) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `this export is format version ${manifest.format_version}; this installation reads version ${SUPPORTED_VERSION}`,
      );
    }
  }

  /**
   * Refuses a workspace that already holds knowledge, and says how much.
   *
   * Merging two workspaces that may share item ids is a reconciliation, not an
   * import, and doing it silently is the blind insert this milestone exists to
   * avoid.
   */
  async expectEmpty(workspaceId: WorkspaceId): Promise<void> {
    const held = await this.o.items.countFor(workspaceId);
    if (held > 0) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `that workspace already holds ${held} items; importing into it would be a reconciliation, not an import`,
        { objectIds: { workspace: workspaceId } },
      );
    }
  }

  /**
   * Recreates the actors the commits name, and answers the map from old to new.
   *
   * New ids, kept names: these are this installation's rows, and an export
   * imported twice here would otherwise collide on a primary key for a reason
   * that has nothing to do with the knowledge (ADR 0035). The exception is the
   * system actor, which every workspace has exactly one of and which means the
   * same thing on both sides.
   */
  async recreateActors(
    workspaceId: WorkspaceId,
    manifest: ImportManifest,
  ): Promise<Map<string, ActorId>> {
    const now = this.clock.now();
    const map = new Map<string, ActorId>();
    // The system actor is the installation itself, and this workspace already
    // has one — a workspace may hold exactly one. What the other installation's
    // system did, this one's system is the right name for.
    const system = await this.o.actors.findSystemActor(workspaceId);
    await this.o.uow.run(async (tx) => {
      for (const actor of manifest.actors) {
        if (actor.type === 'system') {
          if (system) map.set(actor.id, system.id);
          continue;
        }
        const id = newId('act') as ActorId;
        await this.o.actors.insert(tx, {
          id,
          workspaceId,
          type: actor.type as ActorType,
          displayName: actor.display_name,
          // Nobody here: an actor with no user and no agent behind it names who
          // wrote something and grants nothing.
          userId: null,
          agentId: null,
          createdAt: now,
          disabledAt: null,
        });
        map.set(actor.id, id);
      }
    });
    return map;
  }

  /**
   * The category tree, from the file that is the canonical record of it.
   *
   * Before the commits, because a revision names its categories by path and the
   * rows have to exist to be pointed at. The tree that comes back is the one the
   * export was taken at — `taxonomy.yaml` is rewritten whole on every change
   * (GIT_REPOSITORY.md section 6), so the newest file is the whole answer and
   * replaying every taxonomy commit would arrive at exactly this.
   */
  async restoreTaxonomy(
    workspaceId: WorkspaceId,
    by: ActorContext,
  ): Promise<{ categories: number }> {
    const file = await this.o.git.read(workspaceId, this.o.taxonomyPath);
    if (file === null) return { categories: 0 };
    const parsed = this.o.parseTaxonomy(file);
    const now = this.clock.now();
    const head = await this.o.git.headCommit(workspaceId);
    // Parents before children: the path decides the shape, and a shorter path is
    // always the parent of a longer one that starts with it.
    const ordered = [...parsed.categories].sort((a, b) => a.path.length - b.path.length);
    const byPath = new Map<string, CategoryId>();

    await this.o.uow.run(async (tx) => {
      for (const category of ordered) {
        const id = newId('cat') as CategoryId;
        const cut = category.path.lastIndexOf('/');
        await this.o.categories.insert(tx, {
          id,
          workspaceId,
          parentId: cut === -1 ? null : (byPath.get(category.path.slice(0, cut)) ?? null),
          slug: category.slug,
          path: category.path,
          name: category.name,
          description: category.description,
          inclusionGuidance: category.inclusionGuidance,
          exclusionGuidance: category.exclusionGuidance,
          status: category.status as CategoryStatus,
          mergedIntoCategoryId: null,
          createdByActorId: by.actorId,
          approvedByActorId: null,
          createdAt: now,
          updatedAt: now,
        });
        byPath.set(category.path, id);
        if (category.aliases.length > 0) {
          await this.o.aliases.replaceForCategory(
            tx,
            id,
            category.aliases.map((alias) => ({
              id: newId('alias'),
              categoryId: id,
              workspaceId,
              alias,
              normalisedAlias: alias.trim().toLowerCase(),
              createdAt: now,
            })),
          );
        }
      }
      if (head) await this.o.versions.bump(tx, workspaceId, now, parsed.version, head);
    });
    return { categories: ordered.length };
  }

  /**
   * The files the export listed, as rows, before any revision cites one.
   *
   * Their ids survive, like an item's: the frontmatter of an item made from a
   * file names the attachment by id, and a source row points at it. So these
   * have to exist before the commits are walked, or the first source that names
   * one has nothing to point at.
   *
   * A file whose bytes did not come along is recorded as `failed` and says so.
   * The alternative is a row claiming to hold something the store does not have,
   * which is the state `knoverge integrity check` reports as unrepairable.
   */
  async restoreAttachments(
    workspaceId: WorkspaceId,
    by: ActorContext,
    manifest: ImportManifest,
    holds: (contentHash: string) => Promise<boolean>,
  ): Promise<{ restored: number; withoutBytes: string[] }> {
    const now = this.clock.now();
    const withoutBytes: string[] = [];
    await this.o.uow.run(async (tx) => {
      for (const attachment of manifest.attachments) {
        const here = attachment.included && (await holds(attachment.content_hash));
        if (!here) withoutBytes.push(attachment.id);
        await this.o.attachments.insert(tx, {
          id: attachment.id as AttachmentId,
          workspaceId,
          contentHash: attachment.content_hash,
          mediaType: attachment.media_type,
          sizeBytes: attachment.size_bytes,
          filename: attachment.filename,
          originalUri: null,
          // Whoever uploaded it did so in another installation, and the event
          // that recorded them stayed there (ADR 0034).
          uploadedByActorId: by.actorId,
          // Already read: the items the export carries are what came out of it,
          // so reading it again would write them a second time.
          extractionState: here ? 'extracted' : 'failed',
          extractionError: here ? null : 'the export did not carry this file',
          extractionStartedAt: null,
          createdAt: now,
        });
      }
    });
    return { restored: manifest.attachments.length - withoutBytes.length, withoutBytes };
  }

  /**
   * Walks the bundle's commits oldest first and writes what each one made.
   *
   * `by` is the actor the import itself is attributed to — the events say who
   * ran the command. The revisions say who wrote them, through the map.
   */
  async replay(
    workspaceId: WorkspaceId,
    by: ActorContext,
    actorMap: ReadonlyMap<string, ActorId>,
  ): Promise<Omit<ImportOutcome, 'workspaceId' | 'actors'>> {
    const commits = await this.o.git.commits(workspaceId);
    const operationId = newId('op');
    const now = this.clock.now();
    // The commit the workspace ends up at. One operation covers the whole
    // import, and what it brought the repository to is its head — an operation
    // that reached the database must name a commit, and this is the one.
    const head = commits.at(-1) ?? null;
    await this.o.uow.run((tx) =>
      this.o.operations.insert(tx, {
        id: operationId,
        workspaceId,
        actorId: by.actorId,
        operationType: 'import',
        state: head ? 'db_committed' : 'failed',
        objectIds: {},
        intendedPayloadHash: null,
        gitCommitHash: head,
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

    // Read once, because the ids have to be checked before anything is written
    // and the same trailers are what the writing works from.
    const read = await Promise.all(
      commits.map(async (commit) => ({
        commit,
        trailers: await this.o.git.trailersOf(workspaceId, commit),
      })),
    );
    const planned = read.flatMap(({ trailers }) =>
      trailers
        .filter(([name]) => name === 'Knoverge-Change')
        .map(([, value]) => CHANGE.exec(value))
        .filter((match): match is RegExpExecArray => match !== null),
    );
    // Item ids survive an export, which is what makes two installations holding
    // one id be holding one item — and what means an import cannot land where
    // the ids are already taken. Said in words rather than as a primary key
    // violation halfway through (ADR 0035).
    const taken = await this.o.items.existingIds([
      ...new Set(planned.map((match) => match[1] as KnowledgeItemId)),
    ]);
    if (taken.length > 0) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `this installation already holds ${taken.length} of these items, starting with ${taken[0]}; an export can only be imported where its items are not already known`,
        { objectIds: { knowledge_item: taken[0] as string } },
      );
    }

    const skipped: string[] = [];
    const seen = new Set<string>();
    let revisions = 0;
    for (const { commit, trailers } of read) {
      const changes = trailers
        .filter(([name]) => name === 'Knoverge-Change')
        .map(([, value]) => CHANGE.exec(value))
        .filter((match): match is RegExpExecArray => match !== null);
      if (changes.length === 0) continue;

      for (const match of changes) {
        const [, itemId, revisionId, kind] = match as unknown as [
          string,
          KnowledgeItemId,
          RevisionId,
          ChangeKind,
        ];
        const actorId = actorMap.get(trailerValue(trailers, 'Knoverge-Actor') ?? '') ?? by.actorId;
        const written = await this.one(workspaceId, commit, itemId, revisionId, kind, {
          actorId,
          operationId,
          by,
          seen,
        });
        if (written) revisions += 1;
        else skipped.push(commit);
      }
    }
    return { commits: commits.length, items: seen.size, revisions, skipped };
  }

  /** One revision named by one commit, or false when the commit cannot give it. */
  private async one(
    workspaceId: WorkspaceId,
    commit: string,
    itemId: KnowledgeItemId,
    revisionId: RevisionId,
    kind: ChangeKind,
    context: {
      actorId: ActorId;
      operationId: string;
      by: ActorContext;
      seen: Set<string>;
    },
  ): Promise<boolean> {
    const existing = await this.o.items.findById(workspaceId, itemId);
    const now = this.clock.now();

    if (kind === 'delete') {
      if (!existing) return false;
      const previous = await this.o.revisions.findById(
        workspaceId,
        existing.currentRevisionId as RevisionId,
      );
      if (!previous) return false;
      await this.o.uow.run(async (tx) => {
        await this.o.revisions.insert(tx, {
          id: revisionId,
          knowledgeItemId: itemId,
          workspaceId,
          revisionNumber: previous.revisionNumber + 1,
          contentHash: previous.contentHash,
          frontmatterHash: previous.frontmatterHash,
          gitCommitHash: commit,
          title: previous.title,
          markdownPath: previous.markdownPath,
          frontmatter: { ...previous.frontmatter, status: 'deleted' } as Frontmatter,
          changeKind: kind,
          createdByActorId: context.actorId,
          createdAt: now,
          operationId: context.operationId,
          reason: null,
        });
        await this.o.items.update(tx, itemId, {
          status: 'deleted',
          currentRevisionId: revisionId,
          updatedAt: now,
          deletedAt: now,
        });
        await this.o.search.remove(tx, itemId);
      });
      return true;
    }

    // Which file the commit put the item at. The path can change between
    // revisions — a category move takes the file with it — so it is read from
    // the commit rather than from wherever the item is now.
    const path = await this.pathOf(workspaceId, commit, itemId, existing?.markdownPath ?? null);
    if (!path) return false;
    const file = await this.o.git.readAt(workspaceId, commit, path);
    if (file === null) return false;
    const parsed = this.o.parseItem(file);
    if (parsed.frontmatter.id !== itemId) return false;

    const f = parsed.frontmatter;
    const tree = await this.o.categories.list(workspaceId, { includeArchived: true });
    // A path the taxonomy no longer has is an older revision naming a category
    // that was renamed since. The frontmatter keeps what it said; the index
    // carries what can still be pointed at.
    const categories = f.categories
      .map((wanted, position) => {
        const found = tree.find((c) => c.path === wanted);
        return found
          ? { knowledgeItemId: itemId, categoryId: found.id, isPrimary: position === 0, position }
          : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const previousNumber = existing?.currentRevisionId
      ? ((await this.o.revisions.findById(workspaceId, existing.currentRevisionId as RevisionId))
          ?.revisionNumber ?? 0)
      : 0;

    await this.o.uow.run(async (tx) => {
      const revision = {
        id: revisionId,
        knowledgeItemId: itemId,
        workspaceId,
        revisionNumber: previousNumber + 1,
        contentHash: this.o.contentHash(f.title, parsed.body),
        frontmatterHash: this.o.frontmatterHash(JSON.stringify(f)),
        gitCommitHash: commit,
        title: f.title,
        markdownPath: path,
        frontmatter: f,
        changeKind: kind,
        createdByActorId: context.actorId,
        createdAt: now,
        operationId: context.operationId,
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
          createdByActorId: context.actorId,
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
          deletedAt: null,
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
          createdByActorId: context.actorId,
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
      // One event per item rather than per revision: the ledger of this
      // workspace records that this knowledge arrived, attributed to whoever
      // ran the import. The revisions carry the history (ADR 0035).
      if (!context.seen.has(itemId)) {
        await this.o.ledger.append(tx, workspaceId, context.by, {
          eventType: 'knowledge.created',
          objectType: 'knowledge_item',
          objectId: itemId,
          categoryIds: categories.map((c) => c.categoryId),
          afterRevisionId: revisionId,
          afterContentHash: revision.contentHash,
          metadata: { imported: true },
        });
      }
    });
    context.seen.add(itemId);
    return true;
  }

  /**
   * Where the item's file is at this commit.
   *
   * The layout follows the category paths in the frontmatter
   * (`GIT_REPOSITORY.md` section 1), but the slug does not follow from the
   * title, so the path cannot be computed. What the commit changed is the short
   * list to look in, and the frontmatter's own id is what settles it.
   */
  private async pathOf(
    workspaceId: WorkspaceId,
    commit: string,
    itemId: KnowledgeItemId,
    known: string | null,
  ): Promise<string | null> {
    const changed = (await this.o.git.changedFiles(workspaceId, commit)).filter(
      (path) => path.startsWith('knowledge/') && path.endsWith('.md'),
    );
    // What this commit touched first, because that is what it is about; the
    // path the item already has second, for a commit that moved something else.
    for (const path of known ? [...changed, known] : changed) {
      const file = await this.o.git.readAt(workspaceId, commit, path);
      if (file === null) continue;
      try {
        if (this.o.parseItem(file).frontmatter.id === itemId) return path;
      } catch {
        // A file the parser refuses is not this item's; the integrity check is
        // what reports one, not the import.
      }
    }
    return null;
  }
}

/** The first value of a trailer, or undefined when the commit has none. */
function trailerValue(trailers: readonly [string, string][], name: string): string | undefined {
  return trailers.find(([key]) => key === name)?.[1];
}
