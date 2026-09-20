import type { MembershipRole, UserId, WorkspaceId } from '@knoverge/contracts';
import { ROLE_PERMISSIONS } from '@knoverge/policy';

import type { ActorContext } from '../actor-context.ts';
import type { ActorStanding, AuthorizationService } from '../authorization/service.ts';
import { DomainError } from '../errors.ts';
import { addMember } from '../identity/bootstrap-service.ts';
import type {
  MemberWithUser,
  MembershipRepository,
  SessionRepository,
  UserRecord,
} from '../identity/repository.ts';
import type { UserService } from '../identity/user-service.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type { ActorRepository, WorkspaceRepository } from './repository.ts';

export interface MemberServiceOptions {
  uow: UnitOfWork;
  memberships: MembershipRepository;
  actors: ActorRepository;
  workspaces: WorkspaceRepository;
  users: UserService;
  /** Resetting a password ends every session that used the old one. */
  sessions: SessionRepository;
  authorization: AuthorizationService;
  ledger: EventLedger;
  clock?: Clock;
}

export interface AddMemberInput {
  email: string;
  role: MembershipRole;
  displayName?: string | undefined;
  /** Required when no user exists for this email. */
  initialPassword?: string | undefined;
}

export interface UpdateWorkspaceInput {
  name?: string | undefined;
  description?: string | null | undefined;
  defaultLanguage?: string | undefined;
}

/**
 * Workspace membership. Self-hosted installations have no mail server, so an
 * administrator either adds an existing account by email or creates one with a
 * password they pass on out of band.
 */
export class MemberService {
  private readonly o: MemberServiceOptions;
  private readonly clock: Clock;

  constructor(options: MemberServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  list(workspaceId: WorkspaceId): Promise<MemberWithUser[]> {
    return this.o.memberships.listForWorkspace(workspaceId);
  }

  async add(
    actor: ActorContext,
    standing: ActorStanding,
    input: AddMemberInput,
  ): Promise<MemberWithUser> {
    await this.assertMayAssign(actor, standing, input.role);
    const existing = await this.o.users.findByEmail(input.email);
    let user: UserRecord;
    let created = false;
    if (existing) {
      user = existing;
      if (await this.o.memberships.find(actor.workspaceId, user.id)) {
        throw new DomainError('VALIDATION_ERROR', 'this user is already a member');
      }
    } else {
      if (!input.initialPassword) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'no account exists for this email; provide an initial password to create one',
        );
      }
      user = await this.o.users.prepare({
        email: input.email,
        password: input.initialPassword,
        displayName: input.displayName ?? input.email.split('@')[0] ?? input.email,
      });
      created = true;
    }

    const now = this.clock.now();
    await this.o.uow.run(async (tx) => {
      if (created) await this.o.users.insert(tx, user);
      await addMember(this.o, tx, actor.workspaceId, user, input.role, actor.requestId, now, {
        recordUserCreated: created,
        byActorId: actor.actorId,
      });
    });
    const member = (await this.o.memberships.listForWorkspace(actor.workspaceId)).find(
      (m) => m.userId === user.id,
    );
    if (!member) throw new DomainError('INTERNAL_ERROR', 'membership was not created');
    return member;
  }

  async updateRole(
    actor: ActorContext,
    standing: ActorStanding,
    userId: UserId,
    role: MembershipRole,
  ): Promise<void> {
    await this.o.uow.runExclusive(`members:${actor.workspaceId}`, async (tx) => {
      // Inside the lock and the transaction: the owner count decides whether
      // this may happen, so reading it beforehand let two callers each see
      // enough owners and each remove one.
      const membership = await this.o.memberships.find(actor.workspaceId, userId, tx);
      if (!membership) throw new DomainError('NOT_FOUND', 'membership not found');
      if (membership.role === role) return;
      // The workspace invariant is reported first: it is the most specific
      // reason the change cannot happen, whoever is asking.
      await this.assertNotLastOwner(actor.workspaceId, membership.role, role === 'owner', tx);
      await this.assertNotSelf(actor, userId, 'change your own role', tx);
      // Both roles are checked: taking a role away ends every permission it
      // carried, so it takes the same standing as handing that role out.
      await this.assertMayAssign(actor, standing, membership.role);
      await this.assertMayAssign(actor, standing, role);
      await this.o.memberships.updateRole(tx, actor.workspaceId, userId, role);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'membership.updated',
        objectType: 'membership',
        // The membership's own id, not the user's: a lookup by object id in
        // the event feed would never have found it.
        objectId: membership.id,
        metadata: { user_id: userId, role, previous_role: membership.role },
      });
    });
  }

  async remove(actor: ActorContext, standing: ActorStanding, userId: UserId): Promise<void> {
    await this.o.uow.runExclusive(`members:${actor.workspaceId}`, async (tx) => {
      const membership = await this.o.memberships.find(actor.workspaceId, userId, tx);
      if (!membership) throw new DomainError('NOT_FOUND', 'membership not found');
      await this.assertNotLastOwner(actor.workspaceId, membership.role, false, tx);
      await this.assertNotSelf(actor, userId, 'remove yourself', tx);
      // Removing a member ends every permission their role carried, so it takes
      // the same standing as granting that role would.
      await this.assertMayAssign(actor, standing, membership.role);
      await this.o.memberships.remove(tx, actor.workspaceId, userId);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'membership.updated',
        objectType: 'membership',
        objectId: membership.id,
        // The actor stays, so its past events keep their attribution.
        metadata: { user_id: userId, change: 'removed', previous_role: membership.role },
      });
    });
  }

  /**
   * Sets a member's password, for an installation with no mail server to send
   * a reset link through (ADR 0014).
   *
   * The authority rule is the one every other membership action follows: you
   * may act on somebody only if you hold every permission their role includes.
   * Without it this would be a promotion from admin to owner that no role
   * change records — an admin would reset the owner's password and sign in as
   * them.
   *
   * Every session that member holds is revoked. An account that was taken over
   * does not stay taken over, and somebody who did not ask for this finds out
   * at once rather than the next time their session expires.
   */
  async resetPassword(
    actor: ActorContext,
    standing: ActorStanding,
    userId: UserId,
    newPassword: string,
  ): Promise<void> {
    await this.o.uow.runExclusive(`members:${actor.workspaceId}`, async (tx) => {
      const membership = await this.o.memberships.find(actor.workspaceId, userId, tx);
      if (!membership) throw new DomainError('NOT_FOUND', 'membership not found');
      // Changing your own password belongs on the settings page, which checks
      // the current one. Going through here would skip that check.
      await this.assertNotSelf(actor, userId, 'reset your own password', tx);
      await this.assertMayAssign(actor, standing, membership.role);
      await this.o.users.setPassword(tx, userId, newPassword);
      const revoked = await this.o.sessions.revokeAllForUser(tx, userId, this.clock.now());
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'user.password_reset',
        objectType: 'user',
        objectId: userId,
        // The address is not recorded. The ledger holds ids, hashes and actor
        // context; an email address is personal data, and an append-only table
        // is the wrong place to accumulate it.
        metadata: { role: membership.role, sessions_revoked: revoked },
      });
    });
  }

  async updateWorkspace(actor: ActorContext, input: UpdateWorkspaceInput): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0 || name.length > 120) {
        throw new DomainError('VALIDATION_ERROR', 'name must be 1-120 characters');
      }
      patch['name'] = name;
    }
    if (input.description !== undefined) patch['description'] = input.description?.trim() || null;
    if (input.defaultLanguage !== undefined) patch['defaultLanguage'] = input.defaultLanguage;
    if (Object.keys(patch).length === 0) return;
    const now = this.clock.now();
    await this.o.uow.run(async (tx) => {
      await this.o.workspaces.update(tx, actor.workspaceId, { ...patch, updatedAt: now });
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'workspace.updated',
        objectType: 'workspace',
        objectId: actor.workspaceId,
        metadata: { changed: Object.keys(patch).sort() },
      });
    });
  }

  /**
   * A role is a set of permissions, so handing one out is handing out every
   * action in it. An administrator cannot create a member more powerful than
   * themselves, which is the same rule permission grants follow.
   */
  private async assertMayAssign(
    actor: ActorContext,
    standing: ActorStanding,
    role: MembershipRole,
  ): Promise<void> {
    const missing = await this.o.authorization.missingAction(
      actor,
      standing,
      ROLE_PERMISSIONS[role],
    );
    if (missing) {
      throw new DomainError(
        'FORBIDDEN',
        `the ${role} role includes ${missing}, which you do not hold`,
      );
    }
  }

  /**
   * Administering membership is done to other people. Changing your own role
   * turns a grant that can be taken back into a role that cannot.
   */
  private async assertNotSelf(
    actor: ActorContext,
    userId: UserId,
    what: string,
    tx?: Tx,
  ): Promise<void> {
    const self = await this.o.actors.findById(actor.workspaceId, actor.actorId, tx);
    if (self?.userId === userId) {
      throw new DomainError('FORBIDDEN', `you cannot ${what}; ask another administrator`);
    }
  }

  /** A workspace must keep at least one owner who can administer it. */
  private async assertNotLastOwner(
    workspaceId: WorkspaceId,
    currentRole: MembershipRole,
    becomingOwner: boolean,
    tx?: Tx,
  ): Promise<void> {
    if (currentRole !== 'owner' || becomingOwner) return;
    if ((await this.o.memberships.countByRole(workspaceId, 'owner', tx)) <= 1) {
      throw new DomainError('VALIDATION_ERROR', 'a workspace must keep at least one owner');
    }
  }
}
