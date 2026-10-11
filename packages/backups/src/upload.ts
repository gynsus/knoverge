import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Client, SFTPWrapper } from 'ssh2';

import { connect, type Credentials, type SshTarget } from './connect.ts';

/** The machine a finished copy is sent to, as the operator described it. */
export type UploadTarget = SshTarget;

export interface UploadOptions extends Credentials {
  /** The finished copy on this machine: the directory of three files. */
  path: string;
  /** What it is called, which is what the directory on the far end is called. */
  name: string;
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
