import type { WorkspaceId } from '@knoverge/contracts';

/** Who a commit is attributed to. */
export interface CommitAuthor {
  name: string;
  /** `<actor id>@knoverge.local`, so the log points back at the actor. */
  email: string;
}

export interface GitCommitRequest {
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
   * Whether a commit is in this repository's history.
   *
   * Used before writing: PostgreSQL records the commit that wrote each
   * taxonomy version, so a repository that does not contain the newest one is
   * not the repository this workspace's history belongs to.
   */
  hasCommit(workspaceId: WorkspaceId, commitHash: string): Promise<boolean>;
}
