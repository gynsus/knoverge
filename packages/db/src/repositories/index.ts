import type { Database } from '../client.ts';
import { createEventRepository } from './events.ts';
import { createMembershipRepository } from './memberships.ts';
import { createSessionRepository } from './sessions.ts';
import { createUserRepository } from './users.ts';
import { createActorRepository, createWorkspaceRepository } from './workspaces.ts';

/** All repositories over one database handle. */
export function createRepositories(db: Database) {
  return {
    events: createEventRepository(db),
    workspaces: createWorkspaceRepository(db),
    actors: createActorRepository(db),
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    memberships: createMembershipRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
