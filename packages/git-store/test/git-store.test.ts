import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const identity = { authorName: 'Owner', authorEmail: 'act_01J@knoverge.local' };
const at = new Date('2026-09-20T09:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    expect(await repo.commit({ subject: 'no-op', trailers: [], identity, at })).toBeNull();
  });

  it('keeps the content of a deleted file in history', async () => {
    const repo = await repository();
    await repo.write([{ path: 'knowledge/note.md', content: 'First.\n' }]);
    const created = await repo.commit({ subject: 'create: note', trailers: [], identity, at });
    await repo.remove(['knowledge/note.md']);
    await repo.commit({ subject: 'delete: note', trailers: [], identity, at });
    expect(await repo.read('knowledge/note.md')).toBeNull();
    // A logical delete removes the file and keeps what it said.
    expect(await repo.readAt(created!, 'knowledge/note.md')).toBe('First.\n');
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
