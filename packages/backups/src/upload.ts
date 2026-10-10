import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';

/** The machine a finished copy is sent to, as the operator described it. */
export interface UploadTarget {
  host: string;
  port: number;
  username: string;
  /** Absolute on the far machine, and it has to exist already. */
  directory: string;
  authKind: 'private_key' | 'password';
}

export interface UploadOptions {
  /** The finished copy on this machine: the directory of three files. */
  path: string;
  /** What it is called, which is what the directory on the far end is called. */
  name: string;
  target: UploadTarget;
  /** The private key or the password, opened. */
  secret: string;
  /**
   * The fingerprint accepted before, or null on the first connection.
   *
   * A fingerprint rather than the key: equality is all pinning needs, and a
   * digest is also what goes on a screen for an operator to compare against
   * the far machine (ADR 0041).
   */
  knownHostFingerprint: string | null;
}

export interface UploadResult {
  /** What the target presented, `SHA256:…` as `ssh` prints it. */
  hostFingerprint: string;
}

/**
 * What a copy is sent to a second machine with, and why it is not `scp`.
 *
 * The private key is sealed in the database and opened in memory; OpenSSH reads
 * a key from a file and from nowhere else, so using it would mean writing the
 * key out for every run. Password authentication would need a second external
 * program that takes the password on a command line. And host key verification
 * would be the default of a program configured by a file that does not exist.
 * ADR 0041 has the whole comparison.
 *
 * SFTP rather than a command: the account at the far end can be restricted to
 * SFTP with no shell, and this server is then not something that runs anything
 * there.
 */
export async function uploadBackup(options: UploadOptions): Promise<UploadResult> {
  const { client, hostFingerprint } = await connect(options);
  try {
    const sftp = await open(client);
    const remote = `${options.target.directory}/${options.name}`;
    // Staged, then renamed, for the reason the local copy is: a connection that
    // drops halfway must not leave something that looks like a backup and is
    // missing a file. It matters more here, because this is the machine somebody
    // restores from without being able to ask what happened.
    const staging = `${remote}.partial`;
    await stage(sftp, options.target.directory, staging);
    for (const file of (await readdir(options.path)).sort()) {
      await put(sftp, join(options.path, file), `${staging}/${file}`);
    }
    await rename(sftp, staging, remote);
  } finally {
    client.end();
  }
  return { hostFingerprint };
}

/** `SHA256:…`, base64 without padding — what `ssh` and `ssh-keygen` print. */
export function hostFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

/**
 * A connected client, and the fingerprint of whoever answered.
 *
 * The verifier is where pinning happens. On the first connection it accepts
 * what it is given and the caller stores it; afterwards nothing but the same
 * key will do. A rebuilt target machine therefore fails, which is the correct
 * and annoying answer — the message says so, and clearing the pin is one action
 * on the settings screen.
 */
async function connect(
  options: UploadOptions,
): Promise<{ client: Client; hostFingerprint: string }> {
  const client = new Client();
  const { target, secret } = options;
  let presented: string | undefined;
  let changed: string | undefined;

  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    ...(target.authKind === 'private_key' ? { privateKey: secret } : { password: secret }),
    // Only the one the operator chose: offering the others would mean a target
    // that accepts anything getting in on something nobody configured.
    tryKeyboard: false,
    readyTimeout: 20_000,
    // A dead network otherwise hangs the job until somebody notices. Thirty
    // seconds of silence ends the connection; a slow transfer is not silence.
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => {
      presented = hostFingerprint(key);
      if (options.knownHostFingerprint === null) return true;
      if (presented === options.knownHostFingerprint) return true;
      changed = presented;
      return false;
    },
  };

  return new Promise((resolve, reject) => {
    client.on('ready', () => {
      // `presented` is set by the verifier, which runs before the handshake can
      // finish. Narrowing rather than asserting, because an unset one would be
      // an unverified connection and there is no reason to carry on with it.
      if (presented === undefined) {
        client.end();
        reject(new Error('the target did not present a host key'));
        return;
      }
      resolve({ client, hostFingerprint: presented });
    });
    client.on('error', (error: Error) => {
      client.end();
      // Our own message, because the library reports a rejected key as a
      // handshake failure and the operator needs to know which fact changed.
      reject(
        changed === undefined
          ? error
          : new Error(
              `the host key of ${target.host} changed: it now presents ${changed}, and this installation pinned ${options.knownHostFingerprint}. Clear the pinned key to accept the new one.`,
            ),
      );
    });
    client.connect(config);
  });
}

function open(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

/**
 * An empty staging directory, and a target directory that already exists.
 *
 * Not created: the operator typed that path, and creating a tree where they did
 * not mean one is how a backup ends up somewhere nobody looks. A leftover
 * staging directory from a run that died is emptied and reused, because it is
 * ours and its contents are a copy nobody can restore from.
 */
async function stage(sftp: SFTPWrapper, directory: string, staging: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.stat(directory, (error) =>
      error
        ? reject(new Error(`the directory ${directory} does not exist on the target machine`))
        : resolve(),
    );
  });
  const existing = await new Promise<string[] | null>((resolve) => {
    sftp.readdir(staging, (error, list) =>
      resolve(error ? null : list.map((entry) => entry.filename)),
    );
  });
  if (existing === null) {
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(staging, (error) => (error ? reject(error) : resolve()));
    });
    return;
  }
  for (const file of existing) {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(`${staging}/${file}`, (error) => (error ? reject(error) : resolve()));
    });
  }
}

function put(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(from, to, (error) => (error ? reject(error) : resolve()));
  });
}

function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
  });
}
