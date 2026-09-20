import type { CommitAuthor, GitCommitRequest, GitFile, GitStore } from '@knoverge/core';
import type { WorkspaceId } from '@knoverge/contracts';

import { WorkspaceGitRepository, repositoryPath } from './git.ts';
import { renderReadme } from './taxonomy-file.ts';

export interface GitStoreOptions {
  /** Repositories live under `<dataDir>/repositories/<workspace id>`. */
  dataDir: string;
}

/**
 * The Git side of a workspace, one repository per workspace.
 *
 * Handles are cached because opening one is only a path, and the lock that
 * makes a write safe is held elsewhere: two calls for the same workspace can
 * share a handle without sharing a write.
 */
export function createGitStore(options: GitStoreOptions): GitStore {
  const handles = new Map<string, WorkspaceGitRepository>();
  const open = (workspaceId: WorkspaceId): WorkspaceGitRepository => {
    const existing = handles.get(workspaceId);
    if (existing) return existing;
    const repository = new WorkspaceGitRepository(repositoryPath(options.dataDir, workspaceId));
    handles.set(workspaceId, repository);
    return repository;
  };
  const identity = (author: CommitAuthor) => ({
    authorName: author.name,
    authorEmail: author.email,
  });

  return {
    async ensureRepository(workspaceId, workspaceName, author, at) {
      await open(workspaceId).ensure(identity(author), at, renderReadme(workspaceName));
    },
    async write(workspaceId: WorkspaceId, files: readonly GitFile[]) {
      await open(workspaceId).write(files);
    },
    async read(workspaceId: WorkspaceId, path: string) {
      return open(workspaceId).read(path);
    },
    async readAt(workspaceId: WorkspaceId, commitHash: string, path: string) {
      return open(workspaceId).readAt(commitHash, path);
    },
    async remove(workspaceId: WorkspaceId, paths: readonly string[]) {
      await open(workspaceId).remove(paths);
    },
    commit(workspaceId: WorkspaceId, request: GitCommitRequest) {
      return open(workspaceId).commit({
        paths: request.paths,
        subject: request.subject,
        trailers: request.trailers,
        identity: identity(request.author),
        at: request.at,
      });
    },
    hasCommitForOperation(workspaceId: WorkspaceId, operationId: string) {
      return open(workspaceId).hasCommitForOperation(operationId);
    },
    hasCommit(workspaceId: WorkspaceId, commitHash: string) {
      return open(workspaceId).hasCommit(commitHash);
    },
  };
}
