import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';

import type { Database } from '@knoverge/db';

const run = promisify(execFile);

/**
 * The two external programs a restore needs, as a seam.
 *
 * Same reason as the backup's: `pg_restore` has to match the server, so a test
 * that shelled out to whatever is on the machine would pass or fail on the
 * machine. The default is the real pair.
 */
export interface RestoreTools {
  /** Loads a custom-format dump into the configured database. */
  load(file: string, replacing: boolean): Promise<void>;
  /** Unpacks a gzipped archive into `directory`. */
  unpack(file: string, directory: string): Promise<void>;
}

export function systemTools(databaseUrl: string): RestoreTools {
  const parsed = new URL(databaseUrl);
  const args = [
    `--host=${parsed.hostname}`,
    `--port=${parsed.port || '5432'}`,
    `--username=${decodeURIComponent(parsed.username)}`,
    `--dbname=${parsed.pathname.replace(/^\//u, '')}`,
  ];
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) };
  return {
    async load(file, replacing) {
      await run(
        'pg_restore',
        [
          ...args,
          // Only when replacing something: `--clean` on an empty database
          // prints a page of "does not exist" notices and obscures a real
          // failure among them.
          ...(replacing ? ['--clean', '--if-exists'] : []),
          '--no-owner',
          '--no-privileges',
          file,
        ],
        { env },
      );
    },
    async unpack(file, directory) {
      await run('tar', ['-xzf', file, '-C', directory]);
    },
  };
}

/** What a backup's manifest says about itself. */
export interface Manifest {
  takenAt: string;
  /** Where each workspace's ledger stood when the backup was taken. */
  workspaces: { workspaceId: string; slug: string; sequence: number }[];
}

export function parseManifest(text: string): Manifest {
  const lines = text.split('\n');
  const takenAt = lines.find((line) => line.startsWith('taken_at='))?.slice('taken_at='.length);
  const workspaces = lines
    .filter((line) => line.startsWith('workspace='))
    .map((line) => {
      const fields = new Map(
        line.split(' ').map((pair) => {
          const at = pair.indexOf('=');
          return [pair.slice(0, at), pair.slice(at + 1)] as const;
        }),
      );
      return {
        workspaceId: fields.get('workspace') ?? '',
        slug: fields.get('slug') ?? '',
        sequence: Number(fields.get('sequence') ?? 0),
      };
    });
  if (!takenAt) throw new Error('this directory has no manifest a backup would have written');
  return { takenAt, workspaces };
}

/** What is in the way, so the command can say it before it acts. */
export interface Occupied {
  /** Workspaces the database already holds. */
  workspaces: { id: string; slug: string }[];
  /** Other clients connected to this database, which a restore would fight. */
  otherConnections: number;
  /** Entries already in the data directory. */
  dataEntries: string[];
}

/**
 * The name this command's own connections carry.
 *
 * Without it the check counted the command's own pool: a second socket of the
 * restore itself is a backend with another pid, and the command refused to run
 * because it was running.
 */
export const SELF = 'knoverge-restore';

export async function inspectTarget(
  db: Database,
  dataDir: string,
  self: string = SELF,
): Promise<Occupied> {
  const present = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'workspaces'
    ) AS present
  `);
  const workspaces = present.rows[0]?.present
    ? (await db.execute<{ id: string; slug: string }>(sql`SELECT id, slug FROM workspaces`)).rows
    : [];
  const connections = await db.execute<{ others: number }>(sql`
    SELECT count(*)::int AS others FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      -- Clients only. An autovacuum worker is a backend on this database with no
      -- application name, and counting one made the command refuse to run because
      -- the database was tidying itself up — which CI found before an operator did.
      AND backend_type = 'client backend'
      AND coalesce(application_name, '') <> ${self}
  `);
  const dataEntries = await readdir(dataDir).catch(() => [] as string[]);
  return {
    workspaces: workspaces.map((row) => ({ id: row.id, slug: row.slug })),
    otherConnections: connections.rows[0]?.others ?? 0,
    dataEntries,
  };
}

export interface RestoreOptions {
  /** The backup directory: `postgres.dump`, `data.tar.gz`, `manifest.txt`. */
  from: string;
  dataDir: string;
  /** Overwrite a database that already holds knowledge. */
  force: boolean;
  /** The application name this command's own connections carry. */
  self?: string;
}

export interface RestoreResult {
  manifest: Manifest;
  replaced: { id: string; slug: string }[];
  /** Each workspace as the backup recorded it, and as it came back. */
  checks: {
    workspaceId: string;
    slug: string;
    expected: number;
    actual: number;
    ledger: 'ok' | 'broken' | 'missing';
  }[];
}

/**
 * Puts a backup back, and then checks that it came back.
 *
 * The mechanical part is two commands; what makes this worth a command of its own
 * is the two things either side of them. Before: a restore aimed at a live
 * installation is the worst accident available here, so the target is examined
 * and named, and a database that already holds knowledge is refused unless
 * somebody says to replace it. After: the ledger of every workspace is verified
 * and its head compared with the sequence the manifest recorded, because a
 * restore nobody checked is a restore nobody can trust.
 */
export async function restoreBackup(
  db: Database,
  verify: (workspaceId: string) => Promise<{ ok: boolean; count: number }>,
  options: RestoreOptions,
  tools: RestoreTools,
): Promise<RestoreResult> {
  const files = await readdir(options.from).catch(() => {
    throw new Error(`${options.from} is not a directory`);
  });
  for (const needed of ['postgres.dump', 'data.tar.gz', 'manifest.txt']) {
    if (!files.includes(needed)) {
      throw new Error(`${options.from} has no ${needed}; that is not a whole backup`);
    }
  }
  const manifest = parseManifest(await readFile(join(options.from, 'manifest.txt'), 'utf8'));
  const target = await inspectTarget(db, options.dataDir, options.self ?? SELF);

  // A server or a worker holding connections would fight the restore half way
  // through it, and `--clean` would fail on objects in use. Refused, never
  // forced: "stop application writes" is step one of the procedure.
  if (target.otherConnections > 0) {
    throw new Error(
      `${target.otherConnections} other client(s) are connected to this database; stop the application first`,
    );
  }
  if (target.workspaces.length > 0 && !options.force) {
    throw new Error(
      `this database already holds ${target.workspaces.length} workspace(s): ` +
        `${target.workspaces.map((w) => w.slug).join(', ')}. ` +
        'Pass --force to replace what is there.',
    );
  }

  await tools.load(join(options.from, 'postgres.dump'), target.workspaces.length > 0);
  await tools.unpack(join(options.from, 'data.tar.gz'), options.dataDir);

  // From the workspaces and not from the events: a workspace with an empty ledger
  // is a workspace that restored, and reading only `events` would report the one
  // case with nothing in it as the one case that went missing.
  const heads = await db.execute<{ workspace_id: string; sequence: number }>(sql`
    SELECT w.id AS workspace_id, coalesce(max(e.sequence), 0)::int AS sequence
    FROM workspaces w LEFT JOIN events e ON e.workspace_id = w.id
    GROUP BY w.id
  `);
  const bySequence = new Map(heads.rows.map((row) => [row.workspace_id, row.sequence]));
  const checks: RestoreResult['checks'] = [];
  for (const expected of manifest.workspaces) {
    const actual = bySequence.get(expected.workspaceId);
    const chain = actual === undefined ? null : await verify(expected.workspaceId);
    checks.push({
      workspaceId: expected.workspaceId,
      slug: expected.slug,
      expected: expected.sequence,
      actual: actual ?? 0,
      ledger: actual === undefined ? 'missing' : chain?.ok ? 'ok' : 'broken',
    });
  }
  return { manifest, replaced: target.workspaces, checks };
}

/** Whether every workspace came back where the backup left it. */
export function restoredWell(result: RestoreResult): boolean {
  return result.checks.every((check) => check.ledger === 'ok' && check.actual === check.expected);
}
