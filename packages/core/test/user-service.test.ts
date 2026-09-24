import type { UserId } from '@knoverge/contracts';
import type { ActorRepository, SessionRepository } from '../src/index.ts';
import { describe, expect, it, vi } from 'vitest';

import {
  DomainError,
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  UserService,
  type Tx,
  type UnitOfWork,
  type UserRecord,
  type UserRepository,
} from '../src/index.ts';

const NOW = new Date('2026-09-19T12:00:00Z');
const clock = { now: () => NOW };
const uow: UnitOfWork = {
  run: (fn) => fn({} as Tx),
  runExclusive: (_key, fn) => fn({} as Tx),
  withWorkspaceLock: (_workspaceId, fn) => fn(),
};

/** Password hashing stub: reversible, so tests stay fast and deterministic. */
const passwords = {
  hash: async (p: string) => `hashed:${p}`,
  verify: async (p: string, h: string) => h === `hashed:${p}`,
  dummyHash: async () => 'hashed:__dummy__',
};

function repository(initial: UserRecord[] = []) {
  const rows = [...initial];
  const repo: UserRepository = {
    insert: async (_tx, user) => void rows.push(user),
    updateEmail: async () => undefined,
    updateDisplayName: async (_tx, id, displayName) => {
      const user = rows.find((u) => u.id === id);
      if (user) Object.assign(user, { displayName });
    },
    findByEmail: async (email) => rows.find((u) => u.email === email) ?? null,
    findById: async (id) => rows.find((u) => u.id === id) ?? null,
    count: async () => rows.length,
    // Mirrors the SQL: the store adds one and reports the new count, and an
    // expired lockout resets it first.
    recordLoginFailure: async (_tx, id, lockAfter, lockedUntil, resetBefore) => {
      const user = rows.find((u) => u.id === id);
      if (!user) return 0;
      const expired =
        resetBefore !== null && user.lockedUntil !== null && user.lockedUntil <= resetBefore;
      const next = (expired ? 0 : user.failedLoginCount) + 1;
      Object.assign(user, {
        failedLoginCount: next,
        lockedUntil: next >= lockAfter ? lockedUntil : null,
      });
      return next;
    },
    recordLoginSuccess: async (_tx, id, at) => {
      const user = rows.find((u) => u.id === id);
      if (user) Object.assign(user, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at });
    },
    updatePassword: async (_tx, id, passwordHash, at) => {
      const user = rows.find((u) => u.id === id);
      if (user) Object.assign(user, { passwordHash, passwordChangedAt: at });
    },
  };
  return { repo, rows };
}

/** These tests are about the password rules; sessions only have to be callable. */
const sessions = {
  insert: async () => undefined,
  findActiveByTokenHash: async () => null,
  listActiveForUser: async () => [],
  revoke: async () => false,
  revokeAllForUser: async () => 0,
  deleteEndedBefore: async () => 0,
} as unknown as SessionRepository;

/** Counts the actors a rename reached, which is the point of the rename. */
function actorStore() {
  const renamed: { userId: string; displayName: string }[] = [];
  return {
    renamed,
    repo: {
      renameForUser: async (_tx: Tx, userId: string, displayName: string) => {
        renamed.push({ userId, displayName });
        return 2;
      },
    } as unknown as Pick<ActorRepository, 'renameForUser'>,
  };
}

function service(initial: UserRecord[] = []) {
  const { repo, rows } = repository(initial);
  const actors = actorStore();
  return {
    service: new UserService({ uow, users: repo, sessions, actors: actors.repo, passwords, clock }),
    rows,
    renamed: actors.renamed,
  };
}

async function existingUser(email = 'owner@example.com', password = 'correct horse battery') {
  const { service: s, rows } = service();
  const user = await s.prepare({ email, password, displayName: 'Owner' });
  rows.push(user);
  return { service: s, user, rows };
}

describe('UserService.prepare', () => {
  it('normalises the email and hashes the password', async () => {
    const { service: s } = service();
    const user = await s.prepare({
      email: '  Owner@Example.COM ',
      password: 'correct horse battery',
      displayName: '  Owner  ',
    });
    expect(user.email).toBe('owner@example.com');
    expect(user.displayName).toBe('Owner');
    expect(user.passwordHash).toBe('hashed:correct horse battery');
    expect(user.id).toMatch(/^usr_/);
  });

  it('rejects short passwords and invalid emails', async () => {
    const { service: s } = service();
    await expect(
      s.prepare({ email: 'x@y.z', password: 'short', displayName: 'X' }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      s.prepare({ email: 'not-an-email', password: 'correct horse battery', displayName: 'X' }),
    ).rejects.toThrow(/email/);
  });

  it('rejects a password containing a distinctive email local part', async () => {
    const { service: s } = service();
    await expect(
      s.prepare({
        email: 'gregory@example.com',
        password: 'gregory is my password',
        displayName: 'G',
      }),
    ).rejects.toThrow(/email address/);
  });

  it('accepts a password that merely shares letters with a short local part', async () => {
    const { service: s } = service();
    await expect(
      s.prepare({ email: 'o@example.com', password: 'correct horse battery', displayName: 'O' }),
    ).resolves.toMatchObject({ email: 'o@example.com' });
  });
});

describe('UserService.authenticate', () => {
  it('returns the user for correct credentials and clears a recorded failure', async () => {
    const { service: s, user, rows } = await existingUser();
    await expect(s.authenticate('owner@example.com', 'wrong')).rejects.toBeInstanceOf(DomainError);
    expect(rows[0]!.failedLoginCount).toBe(1);

    const authenticated = await s.authenticate('Owner@Example.com', 'correct horse battery');
    expect(authenticated.id).toBe(user.id);
    // Asserted on the stored row, so removing recordLoginSuccess fails the test.
    expect(rows[0]!.failedLoginCount).toBe(0);
    expect(rows[0]!.lastLoginAt).toEqual(NOW);
  });

  it('verifies a dummy hash for unknown emails so timing does not reveal them', async () => {
    const { service: s } = service();
    const verify = vi.spyOn(passwords, 'verify');
    verify.mockClear();
    await expect(s.authenticate('nobody@example.com', 'whatever whatever')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(verify).toHaveBeenCalledWith('whatever whatever', 'hashed:__dummy__');
    verify.mockRestore();
  });

  it('locks the account after repeated failures, without announcing it', async () => {
    const { service: s, rows } = await existingUser();
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
      await expect(s.authenticate('owner@example.com', `wrong ${i}`)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
    expect(rows[0]!.failedLoginCount).toBe(MAX_FAILED_LOGINS);
    expect(rows[0]!.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCKOUT_MS);
    // The right password is refused while locked, and looks like a wrong one.
    await expect(
      s.authenticate('owner@example.com', 'correct horse battery'),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('lets the account in again once the lock has expired', async () => {
    const { service: s, rows } = await existingUser();
    rows[0]!.failedLoginCount = MAX_FAILED_LOGINS;
    rows[0]!.lockedUntil = new Date(NOW.getTime() - 1);
    const user = await s.authenticate('owner@example.com', 'correct horse battery');
    expect(user.failedLoginCount).toBe(0);
    expect(rows[0]!.lockedUntil).toBeNull();
  });

  it('refuses a disabled account with the same message as a wrong password', async () => {
    const { service: s, rows } = await existingUser();
    rows[0]!.status = 'disabled';
    await expect(
      s.authenticate('owner@example.com', 'correct horse battery'),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('UserService.changePassword', () => {
  it('requires the current password and a different new one', async () => {
    const { service: s, user } = await existingUser();
    await expect(
      s.changePassword(user.id, 'wrong', 'another long passphrase'),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      s.changePassword(user.id, 'correct horse battery', 'correct horse battery'),
    ).rejects.toThrow(/differ/);
  });

  it('stores the new hash', async () => {
    const { service: s, user, rows } = await existingUser();
    await s.changePassword(user.id, 'correct horse battery', 'another long passphrase');
    expect(rows[0]!.passwordHash).toBe('hashed:another long passphrase');
    expect(rows[0]!.passwordChangedAt).toEqual(NOW);
  });

  it('reports an unknown user', async () => {
    const { service: s } = service();
    await expect(
      s.changePassword('usr_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as UserId, 'a', 'b'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('UserService.changePassword rules', () => {
  it('refuses a new password containing the email address', async () => {
    const { service: s, user } = await existingUser('gregory@example.com');
    // prepare() refuses this; changePassword did not, so a person could rotate
    // into a password that would have been rejected when they signed up.
    await expect(
      s.changePassword(user.id, 'correct horse battery', 'gregory is my new password'),
    ).rejects.toThrow(/email address/);
  });
});
