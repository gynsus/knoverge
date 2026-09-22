import type { Database } from '../client.ts';
import { createAgentRepository, createCredentialRepository } from './agents.ts';
import {
  createAliasRepository,
  createCategoryRepository,
  createTaxonomyVersionRepository,
} from './categories.ts';
import { createEventRepository } from './events.ts';
import { createIdempotencyRepository } from './idempotency.ts';
import { createPermissionGrantRepository, createPolicyRuleRepository } from './policy.ts';
import { createMembershipRepository } from './memberships.ts';
import { createSessionRepository } from './sessions.ts';
import { createUserRepository } from './users.ts';
import { createKnowledgeRepository, createRevisionRepository } from './knowledge.ts';
import { createRelationRepository, createSourceRepository } from './sources.ts';
import { createProposalRepository } from './proposals.ts';
import { createSearchRepository } from './search.ts';
import { createOperationRepository } from './operations.ts';
import { createActorRepository, createWorkspaceRepository } from './workspaces.ts';

/** All repositories over one database handle. */
export function createRepositories(db: Database) {
  return {
    events: createEventRepository(db),
    agents: createAgentRepository(db),
    credentials: createCredentialRepository(db),
    categories: createCategoryRepository(db),
    aliases: createAliasRepository(db),
    taxonomyVersions: createTaxonomyVersionRepository(db),
    idempotency: createIdempotencyRepository(db),
    grants: createPermissionGrantRepository(db),
    policyRules: createPolicyRuleRepository(db),
    workspaces: createWorkspaceRepository(db),
    actors: createActorRepository(db),
    operations: createOperationRepository(db),
    knowledge: createKnowledgeRepository(db),
    revisions: createRevisionRepository(db),
    sources: createSourceRepository(db),
    relations: createRelationRepository(db),
    proposals: createProposalRepository(db),
    search: createSearchRepository(db),
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    memberships: createMembershipRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
