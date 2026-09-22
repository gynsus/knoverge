import { DisplayName, Email, Locale, Password, type UserId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type { PasswordHasher } from './ports.ts';
import type { SessionRepository, UserRecord, UserRepository } from './repository.ts';

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
  /**
   * A credential and the sessions opened with it have one lifetime: changing
   * either the password or the address ends every session that used the old
   * one, in the same transaction that changed it.
   */
  sessions: SessionRepository;
  passwords: PasswordHasher;
  clock?: Clock;
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  locale?: string;
  /** Which terms this person accepted, for the ones who were asked. */
  acceptedTermsVersion?: string | undefined;
}

export class UserService {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly passwords: PasswordHasher;
  private readonly clock: Clock;

  constructor(options: UserServiceOptions) {
    this.uow = options.uow;
    this.users = options.users;
    this.sessions = options.sessions;
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
      termsVersion: input.acceptedTermsVersion ?? null,
      termsAcceptedAt: input.acceptedTermsVersion ? now : null,
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

    // Unknown, disabled and locked accounts all verify a hash and return the same
    // failure, so response time and payload reveal nothing about the address.
    if (!user || user.status !== 'active' || (user.lockedUntil && user.lockedUntil > now)) {
      await this.passwords.verify(
        password,
        user?.passwordHash ?? (await this.passwords.dummyHash()),
      );
      throw failure();
    }

    const ok = await this.passwords.verify(password, user.passwordHash);
    if (!ok) {
      // The database adds one and tells us the new count, so parallel attempts
      // against one account add up. Computing it here from a value read before
      // an argon2 verify let them overwrite each other, and the account never
      // locked under a parallel attack.
      await this.uow.run((tx) =>
        this.users.recordLoginFailure(
          tx,
          user.id,
          MAX_FAILED_LOGINS,
          new Date(now.getTime() + LOCKOUT_MS),
          now,
        ),
      );
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
    // The same rule choosing a password applies. Without it a person could
    // rotate to a password containing their own address, which prepare refuses.
    if (containsEmail(parsed.data, user.email)) {
      throw new DomainError('VALIDATION_ERROR', 'password must not contain the email address');
    }
    const hash = await this.passwords.hash(parsed.data);
    await this.uow.run((tx) => this.users.updatePassword(tx, userId, hash, this.clock.now()));
  }

  /**
   * Changes the address the account signs in with.
   *
   * The current password is required: a stolen session must not be enough to
   * move an account somewhere its owner cannot follow. Nothing confirms that
   * the new address exists, because an installation has no mail server to
   * confirm it with — ADR 0014 records that, and the settings page says so.
   */
  async changeEmail(userId: UserId, currentPassword: string, newEmail: string): Promise<string> {
    const user = await this.users.findById(userId);
    if (!user) throw new DomainError('NOT_FOUND', 'user not found');
    if (!(await this.passwords.verify(currentPassword, user.passwordHash))) {
      throw new DomainError('UNAUTHENTICATED', 'current password is incorrect');
    }
    const parsed = Email.safeParse(newEmail);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'that is not an email address');
    }
    const email = parsed.data;
    if (email === user.email) {
      throw new DomainError('VALIDATION_ERROR', 'this is already the address on the account');
    }
    // The password rule is checked against the address that will be live, so a
    // change cannot leave a password containing the account's own address.
    if (containsEmail(currentPassword, email)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'the password contains this address; change the password first',
      );
    }
    // A better message than the unique index alone would give. The index is
    // still what makes it true, so a race loses here rather than there.
    if (await this.users.findByEmail(email)) {
      throw new DomainError('VALIDATION_ERROR', 'another account already uses this address');
    }
    await this.uow.run((tx) => this.users.updateEmail(tx, userId, email));
    return email;
  }

  /**
   * Sets a password without knowing the old one.
   *
   * For an administrator resetting a member's password, and for the operator
   * doing the same from the command line — an installation has no mail server
   * to send a reset link through (ADR 0014). The caller is responsible for
   * proving it may: this method checks the password itself and nothing about
   * who is asking.
   */
  async setPassword(tx: Tx, userId: UserId, newPassword: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new DomainError('NOT_FOUND', 'user not found');
    const parsed = Password.safeParse(newPassword);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'password must be 12 to 200 characters');
    }
    if (containsEmail(parsed.data, user.email)) {
      throw new DomainError('VALIDATION_ERROR', 'password must not contain the email address');
    }
    const hash = await this.passwords.hash(parsed.data);
    await this.users.updatePassword(tx, userId, hash, this.clock.now());
  }

  /**
   * Sets a password and ends every session, with no old password and no actor.
   *
   * For the operator at the command line, which is the only route left for the
   * last owner of a workspace: there is nobody above them to ask (ADR 0014).
   * It writes no ledger event, because there is no workspace and no membership
   * to attribute it to — the event feed is per-workspace and an account is not.
   */
  async resetPasswordAsOperator(userId: UserId, newPassword: string): Promise<number> {
    return this.uow.run(async (tx) => {
      await this.setPassword(tx, userId, newPassword);
      return this.sessions.revokeAllForUser(tx, userId, this.clock.now());
    });
  }

  /** The same, for the address the account signs in with. */
  async setEmailAsOperator(userId: UserId, newEmail: string): Promise<number> {
    const user = await this.users.findById(userId);
    if (!user) throw new DomainError('NOT_FOUND', 'user not found');
    const parsed = Email.safeParse(newEmail);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'that is not an email address');
    if (parsed.data === user.email) {
      throw new DomainError('VALIDATION_ERROR', 'this is already the address on the account');
    }
    return this.uow.run(async (tx) => {
      await this.users.updateEmail(tx, userId, parsed.data);
      return this.sessions.revokeAllForUser(tx, userId, this.clock.now());
    });
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
