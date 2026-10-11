import { createHash } from 'node:crypto';

import { Client, type ConnectConfig } from 'ssh2';

/** The machine a finished copy is sent to, as the operator described it. */
export interface SshTarget {
  host: string;
  port: number;
  username: string;
  /** Absolute on the far machine, and it has to exist already. */
  directory: string;
  authKind: 'private_key' | 'password';
}

export interface Credentials {
  target: SshTarget;
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
 *
 * One function for both callers on purpose. The connection a check makes has to
 * be the connection an upload makes, or the check is a rehearsal of something
 * else: the same single authentication method, the same timeouts, the same
 * verifier, and the same pin established by whichever of them gets there first
 * (ADR 0041).
 */
export async function connect(
  options: Credentials,
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
