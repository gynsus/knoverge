import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A commit hash as git prints one, which is all these methods accept. */
const COMMIT_HASH = /^[0-9a-f]{7,64}$/;

/** A trailer name, which is the only shape the commit message builder emits. */
const TRAILER_NAME = /^Knoverge-[A-Za-z][A-Za-z-]*$/;

/** Author and committer of a commit. */
export interface CommitIdentity {
  /** Shown in the log: the person or agent the change is attributed to. */
  authorName: string;
  authorEmail: string;
}

export interface CommitRequest {
  /**
   * The repository-relative paths this operation wrote or removed.
   *
   * Only these are staged. Staging everything would fold whatever else is in
   * the directory — a `.DS_Store`, an editor's swap file, a half-restored
   * backup — into an unrelated domain commit, and would turn a change that
   * alters nothing into a commit carrying only that junk.
   */
  paths: readonly string[];
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
  readonly stderr!: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'GitError';
    // Not enumerable: git's stderr names absolute paths inside the data
    // directory, and pino's error serialiser copies own enumerable properties
    // into the log. A caller that wants it still reads `error.stderr`.
    Object.defineProperty(this, 'stderr', { value: stderr, enumerable: false });
  }
}

/**
 * What never belongs in a workspace repository.
 *
 * Only the paths an operation names are staged, so this is belt and braces —
 * but an operator who runs `git add` by hand should not commit their desktop's
 * leavings into the knowledge history either.
 */
const GITIGNORE = ['.DS_Store', 'Thumbs.db', '*.swp', '*~', '.#*'].join('\n') + '\n';

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
 *
 * Every invocation is hermetic. The repository is named explicitly rather than
 * discovered, so a data directory that happens to sit inside somebody else's
 * working tree can never receive Knoverge's commits; the environment is built
 * from an allowlist rather than inherited, so a stray GIT_DIR cannot redirect a
 * canonical write; and system and global configuration are switched off, so the
 * server never runs a hook, a template or an fsmonitor the operator installed
 * for their own work.
 */
export class WorkspaceGitRepository {
  constructor(readonly root: string) {}

  /** Creates the repository and its first commit when it is not there yet. */
  async ensure(identity: CommitIdentity, at: Date, readme: string): Promise<boolean> {
    if (await this.exists()) return false;
    // What mkdir created, so a failed init does not leave a directory behind
    // that a later call would have to interpret.
    const created = await mkdir(this.root, { recursive: true });
    try {
      await this.git(['init', '--initial-branch=main', '--quiet'], {}, { discover: true });
    } catch (error) {
      if (created !== undefined) await rm(created, { recursive: true, force: true });
      throw error;
    }
    // Local, so the installation does not depend on the operator's global
    // configuration and a commit cannot fail for want of a user.name.
    await this.git(['config', 'user.name', COMMITTER_NAME]);
    await this.git(['config', 'user.email', COMMITTER_EMAIL]);
    await this.write([
      { path: 'README.md', content: readme },
      { path: '.gitignore', content: GITIGNORE },
    ]);
    await this.commit({
      paths: ['README.md', '.gitignore'],
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
    if (request.paths.length === 0) return null;
    const subject = oneLine(request.subject, 'commit subject');
    const trailers = request.trailers.map(([name, value]): [string, string] => {
      if (!TRAILER_NAME.test(name)) {
        throw new GitError(`not a Knoverge trailer name: ${name}`, '');
      }
      return [name, oneLine(value, `trailer ${name}`)];
    });
    const pathspec = await this.stageable(request.paths);
    // A path that is neither on disk nor tracked is a path this operation
    // decided not to write; `git add` would call that pathspec a fatal error.
    if (pathspec.length === 0) return null;
    // `--all` under a pathspec stages a removal as readily as a change, and
    // nothing outside the pathspec at all.
    await this.git(['add', '--all', '--', ...pathspec]);
    const staged = await this.git(['diff', '--cached', '--name-only', '--', ...pathspec]);
    if (staged.trim() === '') return null;

    const message = [subject, '', ...trailers.map(([name, value]) => `${name}: ${value}`)].join(
      '\n',
    );
    const when = request.at.toISOString();
    await this.git(['commit', '--quiet', '--message', message], {
      GIT_AUTHOR_NAME: authorName(request.identity.authorName),
      GIT_AUTHOR_EMAIL: request.identity.authorEmail,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: COMMITTER_EMAIL,
      GIT_COMMITTER_DATE: when,
    });
    const head = (await this.git(['rev-parse', 'HEAD'])).trim();
    // Every taxonomy change rewrites the whole file, so a workspace that is
    // edited often accumulates loose objects that repack far smaller. `--auto`
    // does nothing until git's own thresholds are crossed, and the caller
    // already holds the workspace write lock, so nothing else is writing here.
    // A failure is not the caller's problem: the commit is made either way.
    await this.git(['gc', '--auto', '--quiet']).catch(() => undefined);
    return head;
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
        // Every ref and the reflog, not just the current branch: a commit made
        // while HEAD was detached, or one a reset moved off the branch, is
        // still a commit this operation made, and calling the write failed
        // would discard it.
        '--all',
        '--reflog',
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

  /**
   * Whether a commit is an ancestor of the current branch.
   *
   * Reachability, not mere presence: `cat-file` answers for any object still in
   * the object database, so a branch somebody reset or rewrote would pass until
   * garbage collection ran and fail afterwards — the same repository giving two
   * answers. What the integrity guard means is "is the history we recorded
   * still the history this branch tells".
   */
  async hasCommit(commitHash: string): Promise<boolean> {
    if (!COMMIT_HASH.test(commitHash)) return false;
    try {
      await this.git(['merge-base', '--is-ancestor', commitHash, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /** The trailers of a commit, in order, so recovery can rebuild from them. */
  async trailersOf(commitHash: string): Promise<[string, string][]> {
    this.requireHash(commitHash);
    const body = await this.git(['log', '--format=%B', '--max-count=1', commitHash]);
    const trailers: [string, string][] = [];
    // Only the trailer block at the end of the message counts. Scanning the
    // whole body would let a subject line that looks like a trailer speak for
    // the commit, and a subject is the one part a title can reach.
    for (const line of trailerBlock(body)) {
      const match = /^(Knoverge-[A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
      if (match) trailers.push([match[1] as string, match[2] as string]);
    }
    return trailers;
  }

  /** Commit hashes touching a path, newest first. */
  async history(path: string, limit = 50): Promise<string[]> {
    const count = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const out = await this.git([
      'log',
      '--format=%H',
      `--max-count=${count}`,
      '--follow',
      '--',
      path,
    ]);
    return out.split('\n').filter((line) => line !== '');
  }

  /** A file as it was at a commit, or null when it did not exist then. */
  async readAt(commitHash: string, path: string): Promise<string | null> {
    this.requireHash(commitHash);
    // Relative to the repository root whatever the caller passed, and never an
    // option, because `show` reads `<rev>:<path>` as one argument.
    const inside = relative(this.root, this.resolveInside(path)).split(sep).join('/');
    try {
      return await this.git(['show', `${commitHash}:./${inside}`]);
    } catch {
      return null;
    }
  }

  /**
   * A unified diff between one file at one commit and another at another.
   *
   * Two rev:path pairs rather than one path, because a file moves: an item
   * that changed category is the same item at a different path, and a diff
   * that could not span the move would be blank exactly when it mattered.
   */
  async diffFiles(
    from: { commitHash: string; path: string },
    to: { commitHash: string; path: string },
  ): Promise<string> {
    this.requireHash(from.commitHash);
    this.requireHash(to.commitHash);
    const inside = (path: string) =>
      relative(this.root, this.resolveInside(path)).split(sep).join('/');
    try {
      return await this.git([
        'diff',
        '--no-color',
        '--unified=3',
        `${from.commitHash}:./${inside(from.path)}`,
        `${to.commitHash}:./${inside(to.path)}`,
      ]);
    } catch (error) {
      // `git diff` on two blobs exits 0; a failure here means one of them is
      // not there, which is a question about the repository rather than a
      // difference between two files.
      throw new GitError(`cannot diff those revisions`, (error as GitError).stderr ?? '');
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
    // `.git` is inside the repository and is not part of it. A slug can reach
    // this function once knowledge items are written by path, and `remove`
    // deletes what it is given.
    if (within.split(sep).some((segment) => segment.toLowerCase() === '.git')) {
      throw new GitError(`path reaches into the repository's own metadata: ${path}`, '');
    }
    return full;
  }

  /** The given paths that git can stage: the ones on disk, and the tracked ones. */
  private async stageable(paths: readonly string[]): Promise<string[]> {
    const relatives = paths.map((path) =>
      relative(this.root, this.resolveInside(path)).split(sep).join('/'),
    );
    if (relatives.length === 0) return [];
    const present = await Promise.all(
      relatives.map((path) =>
        access(join(this.root, path)).then(
          () => true,
          () => false,
        ),
      ),
    );
    const tracked = new Set(
      (await this.git(['ls-files', '--', ...relatives])).split('\n').filter((line) => line !== ''),
    );
    return relatives.filter((path, index) => present[index] === true || tracked.has(path));
  }

  /** Whether this exact directory is a repository; never an ancestor of it. */
  private async exists(): Promise<boolean> {
    try {
      const dir = await this.git(
        ['rev-parse', '--resolve-git-dir', this.gitDir],
        {},
        {
          discover: true,
        },
      );
      return dir.trim() !== '';
    } catch {
      return false;
    }
  }

  private get gitDir(): string {
    return join(this.root, '.git');
  }

  private requireHash(commitHash: string): void {
    if (!COMMIT_HASH.test(commitHash)) {
      throw new GitError(`not a commit hash: ${commitHash}`, '');
    }
  }

  private async git(
    args: readonly string[],
    env: Record<string, string> = {},
    options: { discover?: boolean } = {},
  ): Promise<string> {
    // `init` has no repository to name yet, and the existence check names one
    // explicitly in its arguments. Everything else says which repository it
    // means, so no directory above the data directory is ever consulted.
    const where = options.discover ? [] : ['--git-dir', this.gitDir, '--work-tree', this.root];
    const full = [...where, ...HERMETIC_ARGS, ...args];
    try {
      const { stdout } = await run('git', full, {
        cwd: this.root,
        env: { ...hermeticEnv(this.root), ...env },
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      throw new GitError(`git ${args[0]} failed`, stderr);
    }
  }
}

/**
 * Configuration forced on every invocation.
 *
 * `core.hooksPath` is the one that matters: without it a repository the
 * operator configured — husky sets exactly this — would run its pre-commit hook
 * as the server user on every canonical write.
 */
const HERMETIC_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
] as const;

/**
 * The environment git runs in, built from an allowlist.
 *
 * Inheriting the server's environment would let GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, GIT_CONFIG_* or GIT_EXTERNAL_DIFF redirect or subvert a
 * canonical write, and none of them is anything Knoverge sets on purpose.
 */
function hermeticEnv(root: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    // Deterministic output, whatever the host is set to.
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    // The repository is always named explicitly, but a ceiling costs nothing
    // and stops a discovery this code does not perform from ever reaching an
    // operator's own working tree.
    GIT_CEILING_DIRECTORIES: dirname(resolve(root)),
  };
}

/** Refuses a value that would break out of its line in a commit message. */
function oneLine(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new GitError(`empty ${what}`, '');
  if (/[\r\n]/.test(trimmed)) {
    throw new GitError(`${what} must be one line`, '');
  }
  return trimmed;
}

/**
 * The last paragraph of a commit message, which is where trailers live.
 *
 * A one-line subject has no trailer block of its own, so a message with a
 * single paragraph yields nothing rather than yielding its subject.
 */
function trailerBlock(body: string): string[] {
  const paragraphs = body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (paragraphs.length < 2) return [];
  return (paragraphs.at(-1) as string).split('\n').map((line) => line.trim());
}

/**
 * A display name git will render as a name.
 *
 * Git strips angle brackets and newlines itself, which turns
 * `Alice <alice@corp.com>` into an author line that reads like somebody else's
 * address. Removing them here keeps the log honest; the machine-readable
 * attribution is the trailers and the actor address either way.
 */
function authorName(name: string): string {
  const clean = name
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? COMMITTER_NAME : clean;
}

/** Where a workspace's repository lives under the data directory. */
export function repositoryPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'repositories', workspaceId);
}
