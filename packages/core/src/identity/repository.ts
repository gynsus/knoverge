import type {
  ActorId,
  MembershipRole,
  SessionId,
  UserId,
  UserStatus,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface UserRecord {
  id: UserId;
  email: string;
  passwordHash: string;
  displayName: string;
  locale: string;
  status: UserStatus;
  failedLoginCount: number;
  lockedUntil: Date | null;
  passwordChangedAt: Date;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** The terms this person accepted, and when. Null for one never asked. */
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
}

export interface UserRepository {
  insert(tx: Tx, user: UserRecord): Promise<void>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: UserId): Promise<UserRecord | null>;
  count(): Promise<number>;
  /**
   * Adds one to the failure counter in the database and returns the new value.
   *
   * Reading the count and writing back a number computed from it lets parallel
   * attempts overwrite each other: an argon2 verify sits in that window, so
   * twenty-five simultaneous wrong passwords left the counter at two and the
   * account unlocked. The lockout decision is made from the returned value.
   *
   * `lockAfter` is the count at which the account is locked, and `lockedUntil`
   * the time it is locked to, applied only when the new count reaches it.
   */
  recordLoginFailure(
    tx: Tx,
    id: UserId,
    lockAfter: number,
    lockedUntil: Date,
    resetBefore: Date | null,
  ): Promise<number>;
  recordLoginSuccess(tx: Tx, id: UserId, at: Date): Promise<void>;
  updatePassword(tx: Tx, id: UserId, passwordHash: string, at: Date): Promise<void>;
  updateDisplayName(tx: Tx, id: UserId, displayName: string): Promise<void>;
  /**
   * Changes the address the account signs in with.
   *
   * Raises VALIDATION_ERROR when another account already holds it: the address
   * is unique in the database, and a pre-check outside the transaction is a
   * better message, not a guarantee.
   */
  updateEmail(tx: Tx, id: UserId, email: string): Promise<void>;
}

export interface SessionRecord {
  id: SessionId;
  userId: UserId;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

export interface SessionRepository {
  insert(tx: Tx, session: SessionRecord): Promise<void>;
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  listActiveForUser(userId: UserId, now: Date): Promise<SessionRecord[]>;
  revoke(tx: Tx, id: SessionId, at: Date): Promise<boolean>;
  revokeAllForUser(tx: Tx, userId: UserId, at: Date, except?: SessionId): Promise<number>;
  /**
   * Removes sessions that expired or were revoked before the given moment.
   *
   * Rows are kept for a while after they stop working, because the settings
   * page shows a person where they are signed in and recently signing out
   * somewhere should still be visible. Without this they accumulate for the
   * life of the installation.
   */
  deleteEndedBefore(tx: Tx, before: Date): Promise<number>;
}

export interface MembershipRecord {
  id: string;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: MembershipRole;
  actorId: ActorId;
  createdAt: Date;
}

export interface MembershipWithWorkspace extends MembershipRecord {
  workspaceSlug: string;
  workspaceName: string;
  /** Set while that workspace is archived, so a switcher can say so. */
  workspaceArchivedAt: Date | null;
}

export interface MemberWithUser extends MembershipRecord {
  email: string;
  displayName: string;
  status: UserStatus;
  lastLoginAt: Date | null;
}

export interface MembershipRepository {
  insert(tx: Tx, membership: MembershipRecord): Promise<void>;
  updateRole(
    tx: Tx,
    workspaceId: WorkspaceId,
    userId: UserId,
    role: MembershipRole,
  ): Promise<boolean>;
  remove(tx: Tx, workspaceId: WorkspaceId, userId: UserId): Promise<MembershipRecord | null>;
  listForUser(userId: UserId): Promise<MembershipWithWorkspace[]>;
  listForWorkspace(workspaceId: WorkspaceId): Promise<MemberWithUser[]>;
  /**
   * Reads pass the transaction when the answer decides whether a write may
   * happen. Counting owners through the pool and then writing let two removals
   * each see two owners and each remove one, leaving a workspace nobody can
   * administer.
   */
  countByRole(workspaceId: WorkspaceId, role: MembershipRole, tx?: Tx): Promise<number>;
  find(workspaceId: WorkspaceId, userId: UserId, tx?: Tx): Promise<MembershipRecord | null>;
}
