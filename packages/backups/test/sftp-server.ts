import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { Server, utils, type Attributes, type SFTPWrapper } from 'ssh2';

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export interface TestTarget {
  port: number;
  /** The host key it presents, so a test can expect the pin it produces. */
  hostKeyPublic: string;
  /** An authorised client key, in the form the setting stores. */
  clientKey: string;
  close(): Promise<void>;
}

export interface TestTargetOptions {
  /** Where the far end's filesystem actually is. */
  root: string;
  /** The password this target accepts, if it accepts one. */
  password?: string;
  /** Reuse a host key, so a second target can be the same machine — or not. */
  hostKey?: { private: string; public: string };
}

/**
 * A real SSH server, in this process, serving SFTP out of a real directory.
 *
 * Not a stub of the upload: a stub would agree with whatever the upload does,
 * and what has to be right here is the protocol — the handshake, the host key
 * the verifier is handed, the order of SFTP requests, and what ends up on the
 * far end's disk. `ssh2` ships a server as well as a client, so this costs a
 * socket and no container.
 *
 * It is also the only way to test pinning: a second target can be started with
 * the same host key or a different one, which is a rebuilt machine and a
 * machine in the middle, and neither is something a container can be asked for.
 */
export async function startTestTarget(options: TestTargetOptions): Promise<TestTarget> {
  const host = options.hostKey ?? keyPair();
  const client = keyPair();

  const server = new Server({ hostKeys: [host.private] }, (connection) => {
    // A client that refuses the host key walks away mid-handshake, which this
    // side reports as a failed key exchange. That is the far end noticing, not
    // a fault in the test, and an unhandled one would take the run down.
    connection.on('error', () => undefined);
    connection.on('authentication', (context) => {
      // The signature is not checked: what is under test is the client, and a
      // server that verified it would be testing `ssh2` against itself.
      if (context.method === 'publickey') context.accept();
      else if (
        context.method === 'password' &&
        options.password !== undefined &&
        context.password === options.password
      ) {
        context.accept();
      } else context.reject(['publickey', 'password']);
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => serve(acceptSftp(), options.root));
      });
    });
  });

  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hostKeyPublic: host.public,
    clientKey: client.private,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * An ed25519 pair that can be read back.
 *
 * About one in two hundred keys from `generateKeyPairSync` is malformed —
 * `ssh-keygen -y` calls it "invalid format" too, so it is the generator that is
 * wrong and not the parser, and nothing in the product generates a key. Without
 * this, one test in a few dozen runs failed on a key rather than on what it was
 * testing.
 */
export function keyPair(): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error('could not generate a readable key pair');
}

/** Enough of an SFTP server to receive a backup: files, directories, rename. */
function serve(sftp: SFTPWrapper, root: string): void {
  const open = new Map<number, number>();
  const dirs = new Map<number, { path: string; sent: boolean }>();
  let next = 0;
  const handle = (id: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id, 0);
    return buffer;
  };
  const idOf = (buffer: Buffer) => buffer.readUInt32BE(0);
  const real = (path: string) => join(root, path);
  const attrs = (path: string): Attributes => {
    const stats = statSync(path);
    return {
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      size: stats.size,
      atime: Math.floor(stats.atimeMs / 1000),
      mtime: Math.floor(stats.mtimeMs / 1000),
    };
  };

  sftp.on('REALPATH', (id, path) => {
    sftp.name(id, [{ filename: path, longname: path, attrs: {} as Attributes }]);
  });

  // Written out rather than looped: the event name selects the listener's
  // overload, and a loop variable leaves both parameters untyped.
  const stat = (id: number, path: string) => {
    try {
      sftp.attrs(id, attrs(real(path)));
    } catch {
      sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
    }
  };
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);

  sftp.on('OPENDIR', (id, path) => {
    try {
      statSync(real(path));
    } catch {
      sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
      return;
    }
    const key = next++;
    dirs.set(key, { path: real(path), sent: false });
    sftp.handle(id, handle(key));
  });

  sftp.on('READDIR', (id, buffer) => {
    const directory = dirs.get(idOf(buffer));
    // A real listing, and EOF on the second call, because that is how a client
    // knows it has the whole directory. A server that always said EOF would
    // report every directory as empty, and the cleanup of a leftover staging
    // directory would look as though it worked.
    if (directory === undefined || directory.sent) {
      sftp.status(id, STATUS_CODE.EOF);
      return;
    }
    directory.sent = true;
    sftp.name(
      id,
      readdirSync(directory.path).map((filename) => ({
        filename,
        longname: filename,
        attrs: attrs(join(directory.path, filename)),
      })),
    );
  });

  sftp.on('OPEN', (id, filename, flags) => {
    const mode = (flags & OPEN_MODE.WRITE) === 0 ? 'r' : 'w';
    try {
      const fd = openSync(real(filename), mode);
      const key = next++;
      open.set(key, fd);
      sftp.handle(id, handle(key));
    } catch {
      sftp.status(id, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('WRITE', (id, buffer, offset, data) => {
    const fd = open.get(idOf(buffer));
    if (fd === undefined) {
      sftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    writeSync(fd, data, 0, data.length, offset);
    sftp.status(id, STATUS_CODE.OK);
  });

  sftp.on('FSTAT', (id, buffer) => {
    const fd = open.get(idOf(buffer));
    if (fd === undefined) sftp.status(id, STATUS_CODE.FAILURE);
    else sftp.attrs(id, { size: 0 } as Attributes);
  });

  const accept = (id: number) => sftp.status(id, STATUS_CODE.OK);
  sftp.on('FSETSTAT', accept);
  sftp.on('SETSTAT', accept);

  sftp.on('CLOSE', (id, buffer) => {
    const key = idOf(buffer);
    const fd = open.get(key);
    if (fd !== undefined) closeSync(fd);
    open.delete(key);
    dirs.delete(key);
    sftp.status(id, STATUS_CODE.OK);
  });

  sftp.on('MKDIR', (id, path) => {
    try {
      mkdirSync(real(path));
      sftp.status(id, STATUS_CODE.OK);
    } catch {
      sftp.status(id, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('RENAME', (id, from, to) => {
    try {
      renameSync(real(from), real(to));
      sftp.status(id, STATUS_CODE.OK);
    } catch {
      sftp.status(id, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('REMOVE', (id, path) => {
    try {
      unlinkSync(real(path));
      sftp.status(id, STATUS_CODE.OK);
    } catch {
      sftp.status(id, STATUS_CODE.FAILURE);
    }
  });
}

/**
 * The fingerprint a target with this public key will produce.
 *
 * The digest is of the key as it goes over the wire, which is the base64 blob
 * inside an OpenSSH public key line — so this is what `ssh-keygen -lf` prints
 * for the same key, computed without shelling out to it.
 */
export function expectedFingerprint(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/u)[1] as string;
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/u, '')}`;
}

/** What the far end has, for a test to compare against. */
export function listing(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}
