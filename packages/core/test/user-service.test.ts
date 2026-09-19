import type { UserId } from '@knoverge/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  DomainError,
  MAX_FAILED_LOGINS,
  UserService,
  type Tx,
  type UnitOfWork,
  type UserRecord,
  type UserRepository,
} from '../src/index.ts';

const NOW = new Date('2026-09-19T12:00:00Z');
const clock = { now: () => NOW };
const uow: UnitOfWork = { run: (fn) => fn({} as Tx) };

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
    findByEmail: async (email) => rows.find((u) => u.email === email) ?? null,
    findById: async (id) => rows.find((u) => u.id === id) ?? null,
    count: async () => rows.length,
    recordLoginFailure: async (_tx, id, failedLoginCount, lockedUntil) => {
      const user = rows.find((u) => u.id === id);
      if (user) Object.assign(user, { failedLoginCount, lockedUntil });
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

function service(initial: UserRecord[] = []) {
  const { repo, rows } = repository(initial);
  return { service: new UserService({ uow, users: repo, passwords, clock }), rows };
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
  it('returns the user for correct credentials and clears the failure count', async () => {
    const { service: s, user } = await existingUser();
    const authenticated = await s.authenticate('Owner@Example.com', 'correct horse battery');
    expect(authenticated.id).toBe(user.id);
    expect(authenticated.failedLoginCount).toBe(0);
    expect(authenticated.lastLoginAt).toEqual(NOW);
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

  it('locks the account after repeated failures and reports RATE_LIMITED', async () => {
    const { service: s } = await existingUser();
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
      await expect(s.authenticate('owner@example.com', `wrong ${i}`)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
    await expect(
      s.authenticate('owner@example.com', 'correct horse battery'),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
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
