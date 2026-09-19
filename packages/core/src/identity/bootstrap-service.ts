import type { ActorId, UserId, WorkspaceId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type {
  ActorRepository,
  WorkspaceRecord,
  WorkspaceRepository,
} from '../workspace/repository.ts';
import type { WorkspaceService } from '../workspace/service.ts';
import type { MembershipRepository, UserRecord } from './repository.ts';
import type { CreateUserInput, UserService } from './user-service.ts';

export interface BootstrapInput {
  user: CreateUserInput;
  workspace: { slug: string; name: string };
  requestId: string;
}

export interface BootstrapResult {
  user: UserRecord;
  workspace: WorkspaceRecord;
}

export interface BootstrapServiceOptions {
  uow: UnitOfWork;
  users: UserService;
  workspaces: WorkspaceService;
  workspaceRepository: WorkspaceRepository;
  memberships: MembershipRepository;
  actors: ActorRepository;
  ledger: EventLedger;
  clock?: Clock;
}

/**
 * First-run setup: the first administrator and the first workspace, with an
 * owner membership. Allowed only while no user exists (DEPLOYMENT.md section 7).
 */
export class BootstrapService {
  private readonly o: BootstrapServiceOptions;
  private readonly clock: Clock;

  constructor(options: BootstrapServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async isRequired(): Promise<boolean> {
    return (await this.o.users.count()) === 0;
  }

  async run(input: BootstrapInput): Promise<BootstrapResult> {
    if (!(await this.isRequired())) {
      throw new DomainError('FORBIDDEN', 'bootstrap already completed');
    }
    const user = await this.o.users.prepare(input.user);
    const workspace = await this.o.workspaces.create({
      slug: input.workspace.slug,
      name: input.workspace.name,
      requestId: input.requestId,
    });
    await this.o.uow.run(async (tx) => {
      // Guard against two concurrent bootstrap calls: the second sees the first user.
      if ((await this.o.users.count()) > 0) {
        throw new DomainError('FORBIDDEN', 'bootstrap already completed');
      }
      await this.o.users.insert(tx, user);
      await addMember(this.o, tx, workspace.id, user, 'owner', input.requestId, this.clock.now());
    });
    return { user, workspace };
  }
}

type MemberDeps = Pick<BootstrapServiceOptions, 'memberships' | 'actors' | 'ledger'>;

/**
 * Creates the human actor and membership for a user in a workspace and records
 * user.created (first membership only) and membership.created.
 */
export async function addMember(
  deps: MemberDeps,
  tx: Tx,
  workspaceId: WorkspaceId,
  user: UserRecord,
  role: 'owner' | 'admin' | 'reviewer' | 'viewer',
  requestId: string,
  now: Date,
  options: { recordUserCreated?: boolean; byActorId?: ActorId } = { recordUserCreated: true },
): Promise<{ actorId: ActorId }> {
  const actorId = newId('act') as ActorId;
  await deps.actors.insert(tx, {
    id: actorId,
    workspaceId,
    type: 'human',
    displayName: user.displayName,
    userId: user.id,
    agentId: null,
    createdAt: now,
    disabledAt: null,
  });
  await deps.memberships.insert(tx, {
    id: newId('mem'),
    workspaceId,
    userId: user.id,
    role,
    actorId,
    createdAt: now,
  });
  const actor = { actorId: options.byActorId ?? actorId, requestId };
  if (options.recordUserCreated ?? true) {
    await deps.ledger.append(tx, workspaceId, actor, {
      eventType: 'user.created',
      objectType: 'user',
      objectId: user.id as UserId,
      metadata: { locale: user.locale, status: user.status },
    });
  }
  await deps.ledger.append(tx, workspaceId, actor, {
    eventType: 'membership.created',
    objectType: 'membership',
    objectId: user.id,
    metadata: { role, actor_id: actorId },
  });
  return { actorId };
}
