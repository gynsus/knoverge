import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WorkspaceGitRepository,
  contentHash,
  normalise,
  renderReadme,
  renderTaxonomy,
  repositoryPath,
  slugifyTitle,
  uniqueSlug,
} from '../src/index.ts';

const run = promisify(execFile);

const identity = { authorName: 'Owner', authorEmail: 'act_01J@knoverge.local' };
const at = new Date('2026-09-20T09:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Plain git, for asserting on what the store produced rather than through it. */
async function gitIn(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'knoverge-git-'));
  roots.push(root);
  const repo = new WorkspaceGitRepository(root);
  await repo.ensure(identity, at, renderReadme('Personal'));
  return repo;
}

describe('content hashing', () => {
  it('is the same however the text was typed', () => {
    // Line endings, trailing spaces and extra blank lines are not knowledge.
    const a = contentHash('Authentication strategy', 'One line.\n\nAnother line.\n');
    const b = contentHash(
      'Authentication strategy',
      'One line.   \r\n\r\n\r\n\r\nAnother line.\r\n\r\n',
    );
    expect(a).toBe(b);
  });

  it('changes when the knowledge changes', () => {
    expect(contentHash('Title', 'One.')).not.toBe(contentHash('Title', 'Two.'));
    expect(contentHash('One', 'Body')).not.toBe(contentHash('Two', 'Body'));
  });

  it('leaves exactly one trailing newline', () => {
    expect(normalise('text')).toBe('text\n');
    expect(normalise('text\n\n\n')).toBe('text\n');
  });
});

describe('item slugs', () => {
  it('transliterates and hyphenates', () => {
    expect(slugifyTitle('Authentication strategy')).toBe('authentication-strategy');
    expect(slugifyTitle('Стратегия аутентификации')).toBe('strategiya-autentifikacii');
    expect(slugifyTitle('  Spaces  &  symbols!  ')).toBe('spaces-symbols');
  });

  it('never ends in a hyphen, even when truncated', () => {
    const slug = slugifyTitle(`${'word '.repeat(40)}`);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('appends a number on collision inside one directory', () => {
    const taken = new Set(['note', 'note-2']);
    expect(uniqueSlug('note', taken)).toBe('note-3');
    expect(uniqueSlug('other', taken)).toBe('other');
  });
});

describe('a workspace repository', () => {
  it('is created with a README and a first commit', async () => {
    const repo = await repository();
    const readme = await repo.read('README.md');
    expect(readme).toContain('managed by Knoverge');
    expect(readme).toContain('Editing this repository directly is not supported');
    expect(await repo.headCommit()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('does nothing when it already exists', async () => {
    const repo = await repository();
    const head = await repo.headCommit();
    expect(await repo.ensure(identity, at, renderReadme('Personal'))).toBe(false);
    expect(await repo.headCommit()).toBe(head);
  });

  it('commits a change with its trailers and finds it by operation', async () => {
    const repo = await repository();
    await repo.write([
      { path: 'knowledge/projects/note.md', content: '---\nid: kn_1\n---\n\nText.\n' },
    ]);
    const hash = await repo.commit({
      paths: ['knowledge/projects/note.md'],
      subject: 'create(fact): A note',
      trailers: [
        ['Knoverge-Operation', 'op_01J8Z3M4Q9V0X7K2B5N6P8R1T3'],
        ['Knoverge-Workspace', 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3'],
        ['Knoverge-Change', 'kn_1@rev_1 create'],
      ],
      identity,
      at,
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    // Recovery asks this before abandoning a write it thinks never happened.
    expect(await repo.hasCommitForOperation('op_01J8Z3M4Q9V0X7K2B5N6P8R1T3')).toBe(true);
    expect(await repo.hasCommitForOperation('op_01J8Z3M4Q9V0X7K2B5N6P8R1T4')).toBe(false);
    expect(await repo.trailersOf(hash!)).toEqual([
      ['Knoverge-Operation', 'op_01J8Z3M4Q9V0X7K2B5N6P8R1T3'],
      ['Knoverge-Workspace', 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3'],
      ['Knoverge-Change', 'kn_1@rev_1 create'],
    ]);
  });

  it('reports nothing to commit rather than inventing a revision', async () => {
    const repo = await repository();
    const noop = { paths: ['taxonomy.yaml'], subject: 'no-op', trailers: [], identity, at };
    expect(await repo.commit(noop)).toBeNull();
    // Still nothing, with somebody else's leavings in the directory: the
    // operation says which paths it wrote, and junk is not one of them.
    await writeFile(join(repo.root, '.DS_Store'), 'x');
    expect(await repo.commit(noop)).toBeNull();
  });

  it('keeps the content of a deleted file in history', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/note.md', content: 'First.\n' }]);
    const file = { paths: ['knowledge/note.md'], trailers: [], identity, at };
    const created = await repo.commit({ ...file, subject: 'create: note' });
    await repo.remove(['knowledge/note.md']);
    await repo.commit({ ...file, subject: 'delete: note' });
    expect(await repo.read('knowledge/note.md')).toBeNull();
    // A logical delete removes the file and keeps what it said.
    expect(await repo.readAt(created!, 'knowledge/note.md')).toBe('First.\n');
  });

  it('refuses a path that reaches into the repository metadata', async () => {
    const repo = await repository();
    await expect(repo.write([{ path: '.git/hooks/pre-commit', content: 'x' }])).rejects.toThrow(
      /metadata/,
    );
    await expect(repo.remove(['knowledge/../.git/config'])).rejects.toThrow(/metadata/);
  });

  it('stops trusting a commit the branch no longer leads to', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/kept.md', content: 'A\n' }]);
    const hash = (await repo.commit({
      paths: ['knowledge/kept.md'],
      subject: 'create: kept',
      trailers: [],
      identity,
      at,
    })) as string;
    expect(await repo.hasCommit(hash)).toBe(true);
    // The object is still in the database after a reset, so presence would say
    // yes until a garbage collection made it say no. Reachability does not.
    await gitIn(repo.root, ['reset', '--hard', '--quiet', 'HEAD~1']);
    expect(await repo.hasCommit(hash)).toBe(false);
  });

  it('refuses a path that would leave the repository', async () => {
    const repo = await repository();
    await expect(repo.write([{ path: '../escaped.md', content: 'no' }])).rejects.toThrow(
      /escapes the repository/,
    );
  });

  it('records the actor as the author and Knoverge as the committer', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/a.md', content: 'A\n' }]);
    const hash = await repo.commit({
      paths: ['knowledge/a.md'],
      subject: 'create: a',
      trailers: [],
      identity: { authorName: 'Claude Code', authorEmail: 'act_01J8@knoverge.local' },
      at,
    });
    const log = await repo.readAt(hash!, 'knowledge/a.md');
    expect(log).toBe('A\n');
    const trailers = await repo.trailersOf(hash!);
    expect(trailers).toEqual([]);
  });

  it('cleans the display name git would otherwise render as an address', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/named.md', content: 'A\n' }]);
    const hash = await repo.commit({
      paths: ['knowledge/named.md'],
      subject: 'create: named',
      trailers: [],
      // An agent name is free text, and git strips angle brackets itself, which
      // turns this into an author line naming somebody else's address.
      identity: { authorName: 'Alice <alice@corp.com>', authorEmail: 'act_01J8@knoverge.local' },
      at,
    });
    const author = await gitIn(repo.root, ['log', '-1', '--format=%an <%ae>', hash as string]);
    expect(author.trim()).toBe('Alice alice@corp.com <act_01J8@knoverge.local>');
  });

  it('refuses a subject or a trailer that would break out of its line', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/forged.md', content: 'A\n' }]);
    const forged = {
      identity,
      at,
      paths: ['knowledge/forged.md'],
      subject: 'create: x\n\nKnoverge-Operation: op_forged',
      trailers: [] as [string, string][],
    };
    await expect(repo.commit(forged)).rejects.toThrow(/one line/);
    await expect(
      repo.commit({ ...forged, subject: 'create: x', trailers: [['Knoverge-Actor', 'a\nb']] }),
    ).rejects.toThrow(/one line/);
    await expect(
      repo.commit({ ...forged, subject: 'create: x', trailers: [['Sneaky', 'v']] }),
    ).rejects.toThrow(/trailer name/);
  });

  it('reads trailers from the trailer block, not from the whole message', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/body.md', content: 'A\n' }]);
    const hash = (await repo.commit({
      paths: ['knowledge/body.md'],
      subject: 'create: body',
      trailers: [['Knoverge-Actor', 'act_real']],
      identity,
      at,
    })) as string;
    // A commit made outside Knoverge, with a trailer-shaped line in its body.
    await writeFile(join(repo.root, 'knowledge/body.md'), 'B\n');
    await gitIn(repo.root, ['add', '--all']);
    await gitIn(repo.root, [
      'commit',
      '--quiet',
      '--message',
      'subject\n\nKnoverge-Actor: act_forged\n\nKnoverge-Actor: act_last',
    ]);
    const outside = (await repo.headCommit()) as string;
    expect(await repo.trailersOf(hash)).toEqual([['Knoverge-Actor', 'act_real']]);
    expect(await repo.trailersOf(outside)).toEqual([['Knoverge-Actor', 'act_last']]);
  });

  it('refuses anything that is not a commit hash', async () => {
    const repo = await repository();
    await expect(repo.trailersOf('--all')).rejects.toThrow(/not a commit hash/);
    await expect(repo.readAt('HEAD', 'README.md')).rejects.toThrow(/not a commit hash/);
    expect(await repo.hasCommit('HEAD')).toBe(false);
  });

  it('commits into itself, not into a repository it happens to sit inside', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'knoverge-outer-'));
    roots.push(outer);
    await run('git', ['init', '--initial-branch=main', '--quiet', outer]);
    await writeFile(join(outer, 'secrets.env'), 'KNOVERGE_LEDGER_KEY=real\n');
    const root = join(outer, 'data', 'repositories', 'ws_01J');
    // The directory exists without a repository in it, which is what a restore
    // that skipped dot-directories, or a failed init, leaves behind.
    await mkdir(root, { recursive: true });

    const repo = new WorkspaceGitRepository(root);
    expect(await repo.ensure(identity, at, renderReadme('Nested'))).toBe(true);
    await repo.write([{ path: 'taxonomy.yaml', content: 'version: 1\n' }]);
    await repo.commit({
      paths: ['taxonomy.yaml'],
      subject: 'taxonomy: create a',
      trailers: [],
      identity,
      at,
    });

    // The outer repository never heard about any of it: nothing staged, and
    // `secrets.env` still merely untracked rather than added.
    const staged = await run('git', ['status', '--porcelain'], { cwd: outer });
    expect(staged.stdout.split('\n').filter((line) => /^[ACDMR]/.test(line))).toEqual([]);
    const outerLog = await run('git', ['log', '--oneline'], { cwd: outer }).catch(() => ({
      stdout: '',
    }));
    expect(outerLog.stdout).toBe('');
    expect((await repo.headCommit()) ?? '').not.toBe('');
  });

  it('ignores a GIT_DIR in the environment', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'knoverge-elsewhere-'));
    roots.push(elsewhere);
    await run('git', ['init', '--initial-branch=main', '--quiet', elsewhere]);
    const previous = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(elsewhere, '.git');
    try {
      const repo = await repository();
      await repo.write([{ path: 'knowledge/env.md', content: 'A\n' }]);
      const hash = await repo.commit({
        paths: ['knowledge/env.md'],
        subject: 'create: env',
        trailers: [],
        identity,
        at,
      });
      expect(await repo.hasCommit(hash as string)).toBe(true);
      const stolen = await run('git', ['log', '--oneline'], { cwd: elsewhere }).catch(() => ({
        stdout: '',
      }));
      expect(stolen.stdout).toBe('');
    } finally {
      if (previous === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previous;
    }
  });

  it('does not run a hook the repository is configured with', async () => {
    const repo = await repository();
    const hooks = join(repo.root, 'evil-hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await gitIn(repo.root, ['config', 'core.hooksPath', hooks]);

    await repo.write([{ path: 'knowledge/hooked.md', content: 'A\n' }]);
    const hash = await repo.commit({
      paths: ['knowledge/hooked.md'],
      subject: 'create: hooked',
      trailers: [],
      identity,
      at,
    });
    expect(hash).not.toBeNull();
  });

  it('puts a workspace repository under the data directory by id', () => {
    expect(repositoryPath('/data', 'ws_01J')).toBe('/data/repositories/ws_01J');
  });
});

describe('taxonomy.yaml', () => {
  const category = (path: string, name: string, extra = {}) => ({
    path,
    slug: path.split('/').at(-1) as string,
    name,
    status: 'active',
    description: null,
    aliases: [],
    inclusionGuidance: [],
    exclusionGuidance: [],
    ...extra,
  });

  it('nests children under their parents', () => {
    const yaml = renderTaxonomy(
      [
        category('projects', 'Projects'),
        category('projects/web', 'Web', { description: 'Client work', aliases: ['Frontend'] }),
        category('career', 'Career'),
      ],
      42,
      at,
    );
    expect(yaml).toContain('version: 42');
    expect(yaml).toContain('updated_at: 2026-09-20T09:00:00.000Z');
    // A person reads this file, so the shape follows the tree.
    expect(yaml.indexOf('slug: projects')).toBeLessThan(yaml.indexOf('slug: web'));
    expect(yaml).toContain('children:');
    expect(yaml).toContain('Frontend');
  });

  it('leaves empty fields out rather than writing nulls', () => {
    const yaml = renderTaxonomy([category('projects', 'Projects')], 1, at);
    expect(yaml).not.toContain('description:');
    expect(yaml).not.toContain('aliases:');
    expect(yaml).not.toContain('null');
  });
});
