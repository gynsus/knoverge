import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listBackups } from '../src/list.ts';
import { takeBackup, type BackupSource } from '../src/take.ts';
import type { BackupTools } from '../src/tools.ts';

let into: string;
let dataDir: string;

beforeEach(async () => {
  into = await mkdtemp(join(tmpdir(), 'knoverge-backups-into-'));
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-backups-data-'));
});

afterEach(async () => {
  for (const dir of [into, dataDir]) await rm(dir, { recursive: true, force: true });
});

/** What the locks did, in the order they did it. */
let trace: string[] = [];

function source(workspaces: { id: string; slug: string; sequence: number }[]): BackupSource {
  trace = [];
  return {
    workspaces: async () => workspaces.map((w) => ({ id: w.id, slug: w.slug })),
    latestSequence: async (id) => workspaces.find((w) => w.id === id)?.sequence ?? 0,
    async withWorkspaceLock(workspaceId, fn) {
      trace.push(`lock ${workspaceId}`);
      try {
        return await fn();
      } finally {
        trace.push(`unlock ${workspaceId}`);
      }
    },
  };
}

/** A dump and an archive that write a byte each, so the files are real. */
function tools(failing?: 'dump' | 'archive'): BackupTools {
  return {
    async dump(file) {
      trace.push('dump');
      if (failing === 'dump') throw new Error('pg_dump exited 1');
      await writeFile(file, 'PGDMP', 'utf8');
    },
    async archive(file) {
      trace.push('archive');
      if (failing === 'archive') throw new Error('tar exited 2');
      await writeFile(file, 'gz', 'utf8');
    },
  };
}

/** A whole backup that was taken `days` ago, as rotation will find it. */
async function existing(name: string): Promise<void> {
  await mkdir(join(into, name), { recursive: true });
  await writeFile(join(into, name, 'manifest.txt'), 'taken_at=old\n', 'utf8');
}

const ONE = { id: 'ws_b', slug: 'second', sequence: 7 };
const TWO = { id: 'ws_a', slug: 'first', sequence: 3 };

describe('takeBackup', () => {
  it('writes the three files under the moment it was taken', async () => {
    const result = await takeBackup(
      source([ONE]),
      { into, dataDir, retentionDays: 14, now: new Date('2026-10-10T08:30:15Z') },
      tools(),
    );

    expect(result.name).toBe('20261010T083015Z');
    expect((await readdir(result.path)).sort()).toEqual([
      'data.tar.gz',
      'manifest.txt',
      'postgres.dump',
    ]);
  });

  it('refuses a second copy of the same second by name', async () => {
    const options = { into, dataDir, retentionDays: 14, now: new Date('2026-10-10T08:30:15Z') };
    await takeBackup(source([ONE]), options, tools());

    // An operator pressing the button twice. Said before the work rather than
    // discovered at the rename, which is where the whole dump has already been
    // written and the error would be `ENOTEMPTY`.
    await expect(takeBackup(source([ONE]), options, tools())).rejects.toThrow(
      'a backup named 20261010T083015Z was already taken',
    );
    // And the one that is there is the whole one, not a staging directory the
    // refused run left behind.
    expect((await readdir(into)).sort()).toEqual(['20261010T083015Z']);
  });

  it('records where each workspace ledger stood', async () => {
    const result = await takeBackup(
      source([ONE, TWO]),
      { into, dataDir, retentionDays: 14, now: new Date('2026-10-10T08:30:15Z') },
      tools(),
    );

    const manifest = await readFile(join(result.path, 'manifest.txt'), 'utf8');
    expect(manifest).toContain('workspace=ws_b slug=second sequence=7');
    expect(manifest).toContain('workspace=ws_a slug=first sequence=3');
    expect(manifest).toContain(`data_dir=${dataDir}`);
    expect(result.workspaces.map((w) => w.sequence).sort()).toEqual([3, 7]);
  });

  it('holds every workspace lock, in one order, across both steps', async () => {
    await takeBackup(
      source([ONE, TWO]),
      { into, dataDir, retentionDays: 14, now: new Date('2026-10-10T08:30:15Z') },
      tools(),
    );

    // Sorted by id, so two backups at once cannot take them in opposite orders
    // and wait for each other; and nothing is released until the archive is done.
    expect(trace).toEqual([
      'lock ws_a',
      'lock ws_b',
      'dump',
      'archive',
      'unlock ws_b',
      'unlock ws_a',
    ]);
  });

  it('leaves nothing a restore could mistake for a whole backup when a step fails', async () => {
    await expect(
      takeBackup(
        source([ONE]),
        { into, dataDir, retentionDays: 14, now: new Date('2026-10-10T08:30:15Z') },
        tools('archive'),
      ),
    ).rejects.toThrow(/tar exited 2/u);

    expect(await readdir(into)).toEqual([]);
  });

  it('removes copies older than the window and keeps the rest', async () => {
    await existing('20260901T000000Z');
    await existing('20261008T000000Z');

    const result = await takeBackup(
      source([ONE]),
      { into, dataDir, retentionDays: 7, now: new Date('2026-10-10T08:30:15Z') },
      tools(),
    );

    expect(result.removed).toEqual(['20260901T000000Z']);
    expect((await readdir(into)).sort()).toEqual(['20261008T000000Z', '20261010T083015Z']);
  });

  it('keeps what it has just taken, whatever the window', async () => {
    await existing('20260101T000000Z');

    // Everything else on disk is outside a one-day window; an installation
    // whose schedule was broken for a year still comes back with a copy.
    const result = await takeBackup(
      source([ONE]),
      { into, dataDir, retentionDays: 1, now: new Date('2026-10-10T08:30:15Z') },
      tools(),
    );

    expect(result.removed).toEqual(['20260101T000000Z']);
    expect(await readdir(into)).toEqual(['20261010T083015Z']);
  });

  it('does not remove what it did not write, or what a dead run left', async () => {
    await mkdir(join(into, 'somebody-elses-files'), { recursive: true });
    await writeFile(join(into, 'notes.txt'), 'keep me', 'utf8');
    // Old enough to be outside any window, and named almost like a backup. It
    // is what a run that died leaves behind, and it is not a copy of anything:
    // deleting it as though it were one would say a backup had been rotated
    // away when none existed.
    await mkdir(join(into, '20260101T000000Z.partial'), { recursive: true });

    const result = await takeBackup(
      source([ONE]),
      { into, dataDir, retentionDays: 1, now: new Date('2026-10-10T08:30:15Z') },
      tools(),
    );

    expect(result.removed).toEqual([]);
    expect((await readdir(into)).sort()).toEqual([
      '20260101T000000Z.partial',
      '20261010T083015Z',
      'notes.txt',
      'somebody-elses-files',
    ]);
  });
});

describe('listBackups', () => {
  it('lists whole copies newest first, with what they weigh', async () => {
    await takeBackup(
      source([ONE]),
      { into, dataDir, retentionDays: 14, now: new Date('2026-10-09T08:00:00Z') },
      tools(),
    );
    await takeBackup(
      source([ONE]),
      { into, dataDir, retentionDays: 14, now: new Date('2026-10-10T08:00:00Z') },
      tools(),
    );
    await mkdir(join(into, 'half.partial'), { recursive: true });

    const found = await listBackups(into);

    expect(found.map((b) => b.name)).toEqual(['20261010T080000Z', '20261009T080000Z']);
    expect(found[0]?.takenAt.toISOString()).toBe('2026-10-10T08:00:00.000Z');
    // 'PGDMP' and 'gz' and whatever the manifest came to: a number an operator
    // can watch, not an empty one.
    expect(found[0]?.sizeBytes).toBeGreaterThan(7);
  });

  it('says there are none when nothing has ever been taken', async () => {
    expect(await listBackups(join(into, 'never-created'))).toEqual([]);
  });
});
