import type { WorkspaceId } from '@knoverge/contracts';

/** Who a commit is attributed to. */
export interface CommitAuthor {
  name: string;
  /** `<actor id>@knoverge.local`, so the log points back at the actor. */
  email: string;
}

export interface GitCommitRequest {
  /**
   * The paths this operation wrote or removed. Only these are staged, so one
   * domain operation stays one commit whatever else is in the directory.
   */
  paths: readonly string[];
  /** One line, for example `taxonomy: add Projects`. */
  subject: string;
  /** Repeated `Knoverge-*` lines, in the order given. */
  trailers: [string, string][];
  author: CommitAuthor;
  at: Date;
}

export interface GitFile {
  /** Repository-relative, forward slashes, no leading slash. */
  path: string;
  content: string;
}

/**
 * The workspace's canonical repository, as the domain sees it.
 *
 * The domain knows that knowledge is files in a repository, because that is
 * what makes it readable without the application (rule 1). It does not know
 * how a commit is made, so an installation could keep them somewhere else
 * without the domain changing.
 */
export interface GitStore {
  /** Creates the repository with its README when it is not there yet. */
  ensureRepository(
    workspaceId: WorkspaceId,
    workspaceName: string,
    author: CommitAuthor,
    at: Date,
  ): Promise<void>;
  write(workspaceId: WorkspaceId, files: readonly GitFile[]): Promise<void>;
  /**
   * One file as the working tree has it, or null when it is not there.
   *
   * The knowledge itself is only in the file: PostgreSQL indexes an item but
   * never stores its body, so reading one means reading the repository.
   */
  read(workspaceId: WorkspaceId, path: string): Promise<string | null>;
  /**
   * One file as it was at a commit, or null when it did not exist then.
   *
   * What makes history readable, and what a restore reads: a deleted file is
   * gone from the working tree and still in every commit that had it.
   */
  readAt(workspaceId: WorkspaceId, commitHash: string, path: string): Promise<string | null>;
  /** Removes files from the working tree. The history keeps them. */
  remove(workspaceId: WorkspaceId, paths: readonly string[]): Promise<void>;
  /** Returns the commit hash, or null when nothing changed. */
  commit(workspaceId: WorkspaceId, request: GitCommitRequest): Promise<string | null>;
  /**
   * Whether a commit carrying this operation exists. Recovery asks before
   * abandoning a write, because a process can die between committing and
   * recording the hash.
   */
  hasCommitForOperation(workspaceId: WorkspaceId, operationId: string): Promise<boolean>;
  /**
   * Whether a commit is reachable from the current branch.
   *
   * Used before writing: PostgreSQL records the commit that wrote each
   * taxonomy version, so a branch that no longer leads back to the newest one
   * is not the history this workspace's records describe.
   */
  hasCommit(workspaceId: WorkspaceId, commitHash: string): Promise<boolean>;
  /**
   * The `Knoverge-*` trailers of a commit, in order.
   *
   * What recovery reads: a commit that reached Git without its PostgreSQL
   * transaction carries everything needed to write the rows it was missing.
   */
  trailersOf(workspaceId: WorkspaceId, commitHash: string): Promise<[string, string][]>;
}
