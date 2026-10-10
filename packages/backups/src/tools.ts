import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The two external programs a backup needs, as a seam.
 *
 * Not for its own sake: `pg_dump` has to match the server's major version, so a
 * test that shelled out to whatever is on the machine running it would pass or
 * fail on the machine rather than on the code. The default is the real pair, and
 * a test can hand in a pair that runs `pg_dump` inside the database container —
 * which is a real dump of a real database, just not one that depends on the host.
 */
export interface BackupTools {
  /** A custom-format dump of the whole database, at `file`. */
  dump(file: string): Promise<void>;
  /** A gzipped archive of `directory`, at `file`. */
  archive(file: string, directory: string): Promise<void>;
}

/** `pg_dump` and `tar`, with the password kept out of the process list. */
export function systemTools(databaseUrl: string): BackupTools {
  const parsed = new URL(databaseUrl);
  const args = [
    `--host=${parsed.hostname}`,
    `--port=${parsed.port || '5432'}`,
    `--username=${decodeURIComponent(parsed.username)}`,
    `--dbname=${parsed.pathname.replace(/^\//u, '')}`,
  ];
  // Never as an argument: `ps` shows every process's command line to everyone on
  // the machine, and a connection string carries the password.
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) };
  return {
    async dump(file) {
      await run('pg_dump', [...args, '--format=custom', `--file=${file}`], { env });
    },
    async archive(file, directory) {
      // Short flags: the runtime image is Alpine, and busybox tar does not take
      // the long ones the compose backup script uses on Debian.
      await run('tar', ['-czf', file, '-C', directory, '.']);
    },
  };
}
