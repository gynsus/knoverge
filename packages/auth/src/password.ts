import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id parameters (OWASP 2024 minimum: 19 MiB memory, 2 iterations, 1 lane).
 */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * A hash to verify against when the user does not exist, so that login takes
 * the same time whether or not the email is registered.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('knoverge-dummy-password-for-constant-time');
  return dummyHash;
}
