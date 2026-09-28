import type { ItemStatus, KnowledgeItemId, RevisionId, WorkspaceId } from '@knoverge/contracts';

import type { Frontmatter } from '@knoverge/contracts';

import type { AttachmentRepository } from '../attachments/repository.ts';
import { compareFrontmatter } from '../knowledge/frontmatter.ts';
import type { KnowledgeRepository, RevisionRepository } from '../knowledge/repository.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { OperationRepository } from '../operations/repository.ts';
import type { GitStore } from '../ports/git-store.ts';
import type { CategoryRepository, TaxonomyVersionRepository } from '../taxonomy/repository.ts';
import type { WorkspaceRepository } from '../workspace/repository.ts';

/**
 * What an integrity check can find.
 *
 * Each names a way the two stores can disagree, and the architecture treats them
 * very differently. An unfinished operation is expected and repairable — recovery
 * resolves it. A file that does not hash to what the database recorded is not: the
 * knowledge is the file, so there is nothing to repair it from but a backup.
 */
export type FindingKind =
  | 'operation_unfinished'
  | 'ledger_broken'
  | 'commit_missing'
  | 'file_missing'
  | 'content_hash_mismatch'
  | 'frontmatter_hash_mismatch'
  | 'frontmatter_disagrees'
  | 'taxonomy_missing'
  | 'taxonomy_disagrees'
  /**
   * The branch is at a commit the database has never heard of.
   *
   * A commit an operator added by hand contradicts nothing the database recorded —
   * every revision still points at a commit that exists, and every file still
   * hashes to what it should — so the only way to notice one is to look at HEAD.
   * `GIT_REPOSITORY.md` names this as the gap the guard cannot see.
   */
  | 'head_unknown'
  /**
   * A row says this workspace holds a file, and the file is not there.
   *
   * The bytes are the only copy — an attachment is not in Git and cannot be
   * rebuilt from anything — so this is the unrepairable kind, like a knowledge
   * file that does not hash to what was recorded. What it usually means is a data
   * directory restored from a backup older than the row (ADR 0008).
   */
  | 'attachment_missing';

export interface Finding {
  workspaceId: WorkspaceId;
  kind: FindingKind;
  /** The object the finding is about: an item, a revision, an operation. */
  objectId: string;
  /** What was expected and what was there, in one line and never any knowledge. */
  detail: string;
}

export interface WorkspaceIntegrity {
  workspaceId: WorkspaceId;
  slug: string;
  /** Items examined, which is every item including the deleted ones. */
  items: number;
  /** Events the chain was recomputed over. */
  events: number;
  findings: Finding[];
}

export interface IntegrityReport {
  workspaces: WorkspaceIntegrity[];
  findings: Finding[];
  ok: boolean;
}

export interface IntegrityOptions {
  workspaces: WorkspaceRepository;
  items: KnowledgeRepository;
  revisions: RevisionRepository;
  categories: CategoryRepository;
  operations: OperationRepository;
  /** Asked whether a commit wrote a taxonomy version, for the HEAD check. */
  versions: TaxonomyVersionRepository;
  ledger: EventLedger;
  git: GitStore;
  parseItem: (text: string) => { frontmatter: Frontmatter; body: string };
  contentHash: (title: string, body: string) => string;
  frontmatterHash: (yaml: string) => string;
  /** The taxonomy file, parsed into what the categories table should hold. */
  parseTaxonomy: (text: string) => {
    version: number;
    categories: { path: string; slug: string; name: string; status: string }[];
  };
  /** Where the taxonomy lives in a repository. */
  taxonomyPath: string;
  /** Every file a workspace claims to hold, and whether it is on disk. */
  attachments: AttachmentRepository;
  holdsFile: (workspaceId: WorkspaceId, contentHash: string) => Promise<boolean>;
}

/** How many items to read at a time; a workspace may hold a great many. */
const PAGE = 200;

/**
 * Does the repository still say what the database says it says.
 *
 * PostgreSQL holds an index of the knowledge and Git holds the knowledge itself
 * (rule 1 and rule 2), which means the two can disagree and only one of them is
 * canonical. Every write goes through the cross-store writer so that they cannot
 * disagree by accident, and recovery repairs the one case a crash can produce.
 * This is the check that neither of those is quietly failing: it reads what is on
 * disk and compares it with what the database recorded, item by item.
 *
 * It reads and never writes. An integrity checker that repaired things would be
 * the fourth way knowledge changes, and the least reviewed one.
 */
export class IntegrityService {
  private readonly o: IntegrityOptions;

  constructor(options: IntegrityOptions) {
    this.o = options;
  }

  async check(workspaceIds?: readonly WorkspaceId[]): Promise<IntegrityReport> {
    const all = await this.o.workspaces.list();
    const wanted = workspaceIds
      ? all.filter((workspace) => workspaceIds.includes(workspace.id))
      : all;
    const workspaces: WorkspaceIntegrity[] = [];
    for (const workspace of wanted) {
      workspaces.push(await this.checkWorkspace(workspace.id, workspace.slug));
    }
    const findings = workspaces.flatMap((w) => w.findings);
    return { workspaces, findings, ok: findings.length === 0 };
  }

  private async checkWorkspace(
    workspaceId: WorkspaceId,
    slug: string,
  ): Promise<WorkspaceIntegrity> {
    const findings: Finding[] = [];
    const say = (kind: FindingKind, objectId: string, detail: string) =>
      findings.push({ workspaceId, kind, objectId, detail });

    // An operation that never reached db_committed is what recovery resolves, and
    // until it does the workspace refuses writes. Reported rather than repaired:
    // `knoverge db recover` is the command that repairs, and a check that also
    // wrote would hide what it fixed.
    for (const operation of await this.o.operations.listUnfinished(workspaceId)) {
      say(
        'operation_unfinished',
        operation.id,
        `${operation.operationType} is ${operation.state}; run knoverge db recover`,
      );
    }

    const chain = await this.o.ledger.verify(workspaceId);
    if (!chain.ok) {
      say(
        'ledger_broken',
        workspaceId,
        `${chain.reason ?? 'mismatch'} at sequence ${chain.brokenAt ?? 0}`,
      );
    }

    await this.checkTaxonomy(workspaceId, say);
    await this.checkHead(workspaceId, say);
    await this.checkAttachments(workspaceId, say);

    let items = 0;
    let after: KnowledgeItemId | undefined;
    for (;;) {
      // No status filter: every item, including the deleted ones, because a
      // deleted item's file is in the history and the history is the half of the
      // repository nothing else checks.
      const page = await this.o.items.list(workspaceId, {
        limit: PAGE,
        ...(after ? { after } : {}),
      });
      if (page.length === 0) break;
      for (const item of page) {
        items += 1;
        await this.checkItem(workspaceId, item, say);
      }
      after = page[page.length - 1]?.id;
      if (page.length < PAGE) break;
    }

    return { workspaceId, slug, items, events: chain.count, findings };
  }

  /**
   * Every file this workspace says it holds, against the store.
   *
   * The other direction — a file on disk with no row — is not a finding: an
   * upload writes the bytes before the row on purpose, so a crash between the two
   * leaves a few kilobytes nobody asked for rather than a record of something
   * that is not there. Unreferenced bytes cost disk; a missing file costs the
   * file.
   */
  private async checkAttachments(
    workspaceId: WorkspaceId,
    say: (kind: FindingKind, objectId: string, detail: string) => void,
  ): Promise<void> {
    for (const attachment of await this.o.attachments.list(workspaceId, 10_000)) {
      if (await this.o.holdsFile(workspaceId, attachment.contentHash)) continue;
      say(
        'attachment_missing',
        attachment.id,
        `${attachment.contentHash} is recorded and not in the store`,
      );
    }
  }

  /**
   * One item, against the file its current revision produced.
   *
   * A deleted item has no file in the working tree and every commit that had one,
   * so it is checked at its commit instead. That is the same read `knowledge_get`
   * of an older revision does, and it is the only way to check the half of the
   * repository that a working-tree listing cannot see.
   */
  private async checkItem(
    workspaceId: WorkspaceId,
    item: {
      id: KnowledgeItemId;
      currentRevisionId: RevisionId | null;
      markdownPath: string;
      status: ItemStatus;
    },
    say: (kind: FindingKind, objectId: string, detail: string) => void,
  ): Promise<void> {
    const revisionId = item.currentRevisionId;
    if (!revisionId) {
      say('file_missing', item.id, 'the item has no current revision');
      return;
    }
    const revision = await this.o.revisions.findById(workspaceId, revisionId);
    if (!revision) {
      say('file_missing', item.id, `revision ${revisionId} is recorded on the item and not stored`);
      return;
    }
    if (!(await this.o.git.hasCommit(workspaceId, revision.gitCommitHash))) {
      say(
        'commit_missing',
        item.id,
        `revision ${revision.id} names commit ${revision.gitCommitHash.slice(0, 12)}, which the repository does not have`,
      );
      return;
    }
    const text =
      item.status === 'deleted'
        ? await this.o.git.readAt(workspaceId, revision.gitCommitHash, revision.markdownPath)
        : await this.o.git.read(workspaceId, item.markdownPath);
    if (text === null) {
      say('file_missing', item.id, `${revision.markdownPath} is not in the repository`);
      return;
    }

    const parsed = this.o.parseItem(text);
    const content = this.o.contentHash(parsed.frontmatter.title, parsed.body);
    if (content !== revision.contentHash) {
      // The knowledge is the file, so this is the finding nothing can repair: the
      // database's hash says what the text was, and the text is no longer that.
      say(
        'content_hash_mismatch',
        item.id,
        `${revision.markdownPath} hashes to ${content.slice(0, 20)}…, recorded ${revision.contentHash.slice(0, 20)}…`,
      );
    }
    // Against the frontmatter the revision stored, field by field, with the same
    // comparison a diff between two revisions uses. Field names only: a
    // disagreement about a title would otherwise print the title, and a report is
    // not a place for knowledge.
    const changed = compareFrontmatter(revision.frontmatter, parsed.frontmatter)
      .map((change) => change.field)
      .filter((field) => field !== 'updated_at');
    if (changed.length > 0) {
      say(
        'frontmatter_disagrees',
        item.id,
        `${revision.markdownPath} and revision ${revision.id} disagree about ${changed.join(', ')}`,
      );
    }
    if (parsed.frontmatter.status !== item.status) {
      // The row and the file, rather than the file and the revision: these two
      // are written in one operation and a mismatch is the cross-store writer
      // having half failed.
      say(
        'frontmatter_disagrees',
        item.id,
        `the file says status ${parsed.frontmatter.status}, the row says ${item.status}`,
      );
    }
  }

  /**
   * Whether the branch is where the database thinks it is.
   *
   * Not "HEAD is the newest recorded commit": a workspace's history interleaves
   * knowledge commits and taxonomy commits, and hashes carry no order, so the
   * question that can be answered is whether the database has heard of this commit
   * at all. A commit an operator added by hand has not been.
   */
  private async checkHead(
    workspaceId: WorkspaceId,
    say: (kind: FindingKind, objectId: string, detail: string) => void,
  ): Promise<void> {
    const head = await this.o.git.headCommit(workspaceId);
    // No commits at all is a repository nothing has been written to yet, which the
    // per-item checks already say everything about.
    if (head === null) return;
    if (
      (await this.o.revisions.knowsCommit(workspaceId, head)) ||
      (await this.o.versions.knowsCommit(workspaceId, head))
    ) {
      return;
    }
    say(
      'head_unknown',
      workspaceId,
      `the branch is at ${head.slice(0, 12)}, which no revision and no taxonomy version was written by`,
    );
  }

  private async checkTaxonomy(
    workspaceId: WorkspaceId,
    say: (kind: FindingKind, objectId: string, detail: string) => void,
  ): Promise<void> {
    const text = await this.o.git.read(workspaceId, this.o.taxonomyPath);
    const inDatabase = await this.o.categories.list(workspaceId, { includeArchived: true });
    if (text === null) {
      // A workspace nobody has filed anything in has no taxonomy file yet, and
      // reporting that as a disagreement would make every new workspace fail its
      // first check. Missing while the database holds categories is the finding.
      if (inDatabase.length > 0) {
        say(
          'taxonomy_missing',
          workspaceId,
          `${this.o.taxonomyPath} is not in the repository, and the database holds ${inDatabase.length} categories`,
        );
      }
      return;
    }
    const inFile = this.o.parseTaxonomy(text);
    const shape = (rows: readonly { path: string; slug: string; name: string; status: string }[]) =>
      rows
        .map((row) => [row.path, row.slug, row.name, row.status].join(' :: '))
        .sort()
        .join('\n');
    const fromFile = shape(inFile.categories);
    const fromDatabase = shape(inDatabase);
    if (fromFile !== fromDatabase) {
      // Counted rather than diffed: a category name is not knowledge, but a
      // hundred of them in a report is noise, and the tree is one screen away.
      say(
        'taxonomy_disagrees',
        workspaceId,
        `${this.o.taxonomyPath} lists ${inFile.categories.length} categories, the database holds ${inDatabase.length}`,
      );
    }
  }
}
