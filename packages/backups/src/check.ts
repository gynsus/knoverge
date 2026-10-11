import type { SFTPWrapper } from 'ssh2';

import { connect, type Credentials } from './connect.ts';

/**
 * What a check of the target found, stage by stage.
 *
 * Three facts rather than one boolean, because they fail for different reasons
 * and are fixed in different places: the address and the credential are this
 * installation's settings, the directory is somebody else's machine, and a
 * directory that exists but refuses a file is that machine's permissions. An
 * operator who is told only "it did not work" has to guess which.
 *
 * Earlier stages are a precondition for later ones, so a false is followed by
 * false and the reason belongs to the first of them.
 */
export interface TargetCheck {
  /** Connected, verified the host key, and authenticated. */
  connected: boolean;
  /** The directory the operator typed is there. Nothing is created. */
  directoryExists: boolean;
  /** A file was written into it and removed again. */
  writable: boolean;
  /**
   * What the target presented, `SHA256:…`, or null if nothing answered.
   *
   * Reported whether or not the rest worked: an operator comparing this against
   * their own `ssh-keyscan` is doing it because they do not yet trust the
   * machine, and a directory they typed wrongly is no reason to withhold it.
   */
  hostFingerprint: string | null;
  /** One line, the first thing that went wrong, or null. */
  error: string | null;
}

/** The name of the file a check writes, which it then removes. */
function probeName(now: Date): string {
  // Dotted, named, and stamped: if a check is killed between the write and the
  // remove, what is left behind says what left it and when, in a directory
  // whose other contents somebody restores from.
  return `.knoverge-write-check-${now.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
}

/**
 * Whether a copy sent now would arrive, asked without sending one.
 *
 * The same connection an upload makes (ADR 0041), so this is a rehearsal rather
 * than a different thing that happens to use SSH — including the pin: if
 * nothing is pinned yet, whatever answers this is what gets pinned, because
 * "the host key it met first" has to mean one rule and not two.
 *
 * It writes, because "can this directory be written to" cannot be answered by
 * looking. The file is removed again, and a check that cannot remove it says so
 * and names it: leaving something behind in the directory somebody restores
 * from is not a detail to swallow.
 */
export async function checkTarget(options: Credentials & { now?: Date }): Promise<TargetCheck> {
  const result: TargetCheck = {
    connected: false,
    directoryExists: false,
    writable: false,
    hostFingerprint: null,
    error: null,
  };

  let connection;
  try {
    connection = await connect(options);
  } catch (error) {
    result.error = oneLine(error);
    return result;
  }
  result.connected = true;
  result.hostFingerprint = connection.hostFingerprint;

  const { directory } = options.target;
  try {
    const sftp = await open(connection.client);
    try {
      await stat(sftp, directory);
    } catch {
      result.error = `the directory ${directory} does not exist on the target machine`;
      return result;
    }
    result.directoryExists = true;

    const probe = `${directory}/${probeName(options.now ?? new Date())}`;
    try {
      await write(sftp, probe);
    } catch (error) {
      result.error = `the directory ${directory} cannot be written to: ${oneLine(error)}`;
      return result;
    }
    try {
      await remove(sftp, probe);
    } catch (error) {
      result.error =
        `a file was written to ${directory} and could not be removed again, so ${probe} ` +
        `is still there: ${oneLine(error)}`;
      return result;
    }
    result.writable = true;
    return result;
  } catch (error) {
    result.error = oneLine(error);
    return result;
  } finally {
    connection.client.end();
  }
}

function open(client: Awaited<ReturnType<typeof connect>>['client']): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function stat(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * One byte, through the same call an upload's files go through.
 *
 * A zero-length file would be written by an `OPEN` that some servers allow on a
 * directory they will not accept data into, and a check that passes where the
 * upload fails is worse than no check.
 */
function write(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on('error', reject);
    stream.on('close', () => resolve());
    stream.end('knoverge write check\n');
  });
}

function remove(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => (error ? reject(error) : resolve()));
  });
}

/** The far end's words, on one line and bounded: this goes on a screen. */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, ' ').trim().slice(0, 500) || 'the target did not answer';
}
