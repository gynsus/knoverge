import { DisplayName, Email, Locale, Password, type UserId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type { PasswordHasher } from './ports.ts';
import type { UserRecord, UserRepository } from './repository.ts';

export const MAX_FAILED_LOGINS = 10;
/** Local parts shorter than this are too common to treat as a password fragment. */
const MIN_LOCAL_PART_FOR_CHECK = 4;

function containsEmail(password: string, email: string): boolean {
  const lower = password.toLowerCase();
  if (lower.includes(email)) return true;
  const local = email.split('@')[0] ?? '';
  return local.length >= MIN_LOCAL_PART_FOR_CHECK && lower.includes(local);
}

export const LOCKOUT_MS = 15 * 60 * 1000;

export interface UserServiceOptions {
  uow: UnitOfWork;
  users: UserRepository;
  passwords: PasswordHasher;
  clock?: Clock;
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  locale?: string;
}

export class UserService {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly passwords: PasswordHasher;
  private readonly clock: Clock;

  constructor(options: UserServiceOptions) {
    this.uow = options.uow;
    this.users = options.users;
    this.passwords = options.passwords;
    this.clock = options.clock ?? systemClock;
  }

  /** Validates and hashes; the caller inserts inside its own transaction and records the event. */
  async prepare(input: CreateUserInput): Promise<UserRecord> {
    const email = Email.safeParse(input.email);
    if (!email.success) throw new DomainError('VALIDATION_ERROR', 'invalid email address');
    const password = Password.safeParse(input.password);
    if (!password.success) {
      throw new DomainError('VALIDATION_ERROR', 'password must be 12 to 200 characters');
    }
    if (containsEmail(password.data, email.data)) {
      throw new DomainError('VALIDATION_ERROR', 'password must not contain the email address');
    }
    const displayName = DisplayName.safeParse(input.displayName);
    if (!displayName.success) throw new DomainError('VALIDATION_ERROR', 'display name is required');
    const locale = Locale.safeParse(input.locale ?? 'en');
    if (!locale.success) throw new DomainError('VALIDATION_ERROR', 'unsupported locale');
    if (await this.users.findByEmail(email.data)) {
      throw new DomainError('VALIDATION_ERROR', 'email address already registered');
    }
    const now = this.clock.now();
    return {
      id: newId('usr') as UserId,
      email: email.data,
      passwordHash: await this.passwords.hash(password.data),
      displayName: displayName.data,
      locale: locale.data,
      status: 'active',
      failedLoginCount: 0,
      lockedUntil: null,
      passwordChangedAt: now,
      createdAt: now,
      lastLoginAt: null,
    };
  }

  async insert(tx: Tx, user: UserRecord): Promise<void> {
    await this.users.insert(tx, user);
  }

  /**
   * Verifies credentials with constant timing for unknown users, applies the
   * per-account lockout, and records the outcome. Returns the user on success.
   */
  async authenticate(emailInput: string, password: string): Promise<UserRecord> {
    const failure = () => new DomainError('UNAUTHENTICATED', 'invalid email or password');
    const email = Email.safeParse(emailInput);
    const user = email.success ? await this.users.findByEmail(email.data) : null;
    const now = this.clock.now();

    if (!user) {
      await this.passwords.verify(password, await this.passwords.dummyHash());
      throw failure();
    }
    if (user.status !== 'active') throw failure();
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new DomainError('RATE_LIMITED', 'account temporarily locked after repeated failures', {
        retryable: true,
      });
    }

    const ok = await this.passwords.verify(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lockedUntil = failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS) : null;
      await this.uow.run((tx) => this.users.recordLoginFailure(tx, user.id, failed, lockedUntil));
      throw failure();
    }
    await this.uow.run((tx) => this.users.recordLoginSuccess(tx, user.id, now));
    return { ...user, failedLoginCount: 0, lockedUntil: null, lastLoginAt: now };
  }

  async changePassword(
    userId: UserId,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new DomainError('NOT_FOUND', 'user not found');
    if (!(await this.passwords.verify(currentPassword, user.passwordHash))) {
      throw new DomainError('UNAUTHENTICATED', 'current password is incorrect');
    }
    const parsed = Password.safeParse(newPassword);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'password must be 12 to 200 characters');
    }
    if (parsed.data === currentPassword) {
      throw new DomainError('VALIDATION_ERROR', 'new password must differ from the current one');
    }
    const hash = await this.passwords.hash(parsed.data);
    await this.uow.run((tx) => this.users.updatePassword(tx, userId, hash, this.clock.now()));
  }

  findById(id: UserId): Promise<UserRecord | null> {
    return this.users.findById(id);
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.findByEmail(email.trim().toLowerCase());
  }

  count(): Promise<number> {
    return this.users.count();
  }
}
