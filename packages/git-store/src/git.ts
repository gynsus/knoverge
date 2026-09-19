import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Author and committer of a commit. */
export interface CommitIdentity {
  /** Shown in the log: the person or agent the change is attributed to. */
  authorName: string;
  authorEmail: string;
}

export interface CommitRequest {
  /** One line, for example `create(fact): Backend database`. */
  subject: string;
  /** Repeated `Knoverge-*` lines, in the order given. */
  trailers: [string, string][];
  identity: CommitIdentity;
  /** When the commit was made, so a test or a replay is deterministic. */
  at: Date;
}

export interface FileWrite {
  /** Repository-relative, forward slashes, no leading slash. */
  path: string;
  content: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const COMMITTER_NAME = 'Knoverge';
const COMMITTER_EMAIL = 'system@knoverge.local';

/**
 * One workspace's repository on disk.
 *
 * Git is used through its command line rather than a library: it is the
 * reference implementation of its own format, an operator can run the same
 * commands by hand, and the repository stays a plain repository that anybody
 * can clone (ADR 0002). Every call passes arguments as an array, never through
 * a shell, so a title with a quote in it cannot become a command.
 */
export class WorkspaceGitRepository {
  constructor(readonly root: string) {}

  /** Creates the repository and its first commit when it is not there yet. */
  async ensure(identity: CommitIdentity, at: Date, readme: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--git-dir']);
      return false;
    } catch {
      // Not a repository yet.
    }
    await mkdir(this.root, { recursive: true });
    await this.git(['init', '--initial-branch=main', '--quiet']);
    // Local, so the installation does not depend on the operator's global
    // configuration and a commit cannot fail for want of a user.name.
    await this.git(['config', 'user.name', COMMITTER_NAME]);
    await this.git(['config', 'user.email', COMMITTER_EMAIL]);
    await this.write([{ path: 'README.md', content: readme }]);
    await this.commit({
      subject: 'init: Knoverge workspace repository',
      trailers: [],
      identity,
      at,
    });
    return true;
  }

  /** Writes files, creating directories as needed. */
  async write(files: readonly FileWrite[]): Promise<void> {
    for (const file of files) {
      const full = this.resolveInside(file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content, 'utf8');
    }
  }

  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      await rm(this.resolveInside(path), { force: true });
    }
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.resolveInside(path), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Stages everything and commits. Returns the commit hash, or null when there
   * was nothing to commit, which is not an error: a write that changes no byte
   * should not invent a revision.
   */
  async commit(request: CommitRequest): Promise<string | null> {
    await this.git(['add', '--all']);
    const status = await this.git(['status', '--porcelain']);
    if (status.trim() === '') return null;

    const message = [
      request.subject,
      '',
      ...request.trailers.map(([name, value]) => `${name}: ${value}`),
    ].join('\n');
    const when = request.at.toISOString();
    await this.git(['commit', '--quiet', '--message', message], {
      GIT_AUTHOR_NAME: request.identity.authorName,
      GIT_AUTHOR_EMAIL: request.identity.authorEmail,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: COMMITTER_EMAIL,
      GIT_COMMITTER_DATE: when,
    });
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  /**
   * Whether a commit carrying this operation exists.
   *
   * Recovery asks before abandoning a pending write: a process can die between
   * committing and writing the hash down, and calling that failed would discard
   * a commit that is already in history.
   */
  async hasCommitForOperation(operationId: string): Promise<boolean> {
    try {
      const found = await this.git([
        'log',
        '--format=%H',
        `--grep=^Knoverge-Operation: ${operationId}$`,
        '--extended-regexp',
        '--max-count=1',
      ]);
      return found.trim() !== '';
    } catch {
      return false;
    }
  }

  /** The trailers of a commit, in order, so recovery can rebuild from them. */
  async trailersOf(commitHash: string): Promise<[string, string][]> {
    const body = await this.git(['log', '--format=%B', '--max-count=1', commitHash]);
    const trailers: [string, string][] = [];
    for (const line of body.split('\n')) {
      const match = /^(Knoverge-[A-Za-z-]+):\s*(.*)$/.exec(line.trim());
      if (match) trailers.push([match[1] as string, match[2] as string]);
    }
    return trailers;
  }

  /** Commit hashes touching a path, newest first. */
  async history(path: string, limit = 50): Promise<string[]> {
    const out = await this.git([
      'log',
      '--format=%H',
      `--max-count=${limit}`,
      '--follow',
      '--',
      path,
    ]);
    return out.split('\n').filter((line) => line !== '');
  }

  /** A file as it was at a commit, or null when it did not exist then. */
  async readAt(commitHash: string, path: string): Promise<string | null> {
    try {
      return await this.git(['show', `${commitHash}:${path}`]);
    } catch {
      return null;
    }
  }

  async headCommit(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', 'HEAD'])).trim();
    } catch {
      return null;
    }
  }

  /**
   * Refuses a path that would leave the repository. Every path reaching here is
   * built from a slug the contracts validated, so this is the second line, not
   * the first.
   */
  private resolveInside(path: string): string {
    const full = resolve(this.root, path);
    const within = relative(this.root, full);
    if (within.startsWith('..') || within.startsWith(sep) || resolve(within) === within) {
      throw new GitError(`path escapes the repository: ${path}`, '');
    }
    return full;
  }

  private async git(args: readonly string[], env: Record<string, string> = {}): Promise<string> {
    try {
      const { stdout } = await run('git', [...args], {
        cwd: this.root,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      throw new GitError(`git ${args[0]} failed`, stderr);
    }
  }
}

/** Where a workspace's repository lives under the data directory. */
export function repositoryPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'repositories', workspaceId);
}
