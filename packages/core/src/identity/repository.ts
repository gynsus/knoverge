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
}

export interface UserRepository {
  insert(tx: Tx, user: UserRecord): Promise<void>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: UserId): Promise<UserRecord | null>;
  count(): Promise<number>;
  recordLoginFailure(
    tx: Tx,
    id: UserId,
    failedLoginCount: number,
    lockedUntil: Date | null,
  ): Promise<void>;
  recordLoginSuccess(tx: Tx, id: UserId, at: Date): Promise<void>;
  updatePassword(tx: Tx, id: UserId, passwordHash: string, at: Date): Promise<void>;
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
  countByRole(workspaceId: WorkspaceId, role: MembershipRole): Promise<number>;
  find(workspaceId: WorkspaceId, userId: UserId): Promise<MembershipRecord | null>;
}
