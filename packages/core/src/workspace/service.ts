import { type ActorId, LanguageTag, type WorkspaceId, WorkspaceSlug } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { ActorRepository, WorkspaceRecord, WorkspaceRepository } from './repository.ts';

export interface CreateWorkspaceInput {
  slug: string;
  name: string;
  description?: string;
  defaultLanguage?: string;
  requestId: string;
}

export interface WorkspaceServiceOptions {
  uow: UnitOfWork;
  workspaces: WorkspaceRepository;
  actors: ActorRepository;
  ledger: EventLedger;
  clock?: Clock;
}

export const SYSTEM_ACTOR_NAME = 'Knoverge';

export class WorkspaceService {
  private readonly uow: UnitOfWork;
  private readonly workspaces: WorkspaceRepository;
  private readonly actors: ActorRepository;
  private readonly ledger: EventLedger;
  private readonly clock: Clock;

  constructor(options: WorkspaceServiceOptions) {
    this.uow = options.uow;
    this.workspaces = options.workspaces;
    this.actors = options.actors;
    this.ledger = options.ledger;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Creates a workspace together with its system actor and records
   * workspace.created attributed to that actor. Used by bootstrap and by
   * workspace administration; the caller's own attribution is added in metadata.
   */
  async create(
    input: CreateWorkspaceInput,
    createdBy?: { actorId: ActorId; workspaceId: WorkspaceId },
  ): Promise<WorkspaceRecord> {
    const slug = WorkspaceSlug.safeParse(input.slug);
    if (!slug.success) {
      throw new DomainError('VALIDATION_ERROR', `invalid slug: ${slug.error.issues[0]?.message}`);
    }
    const language = LanguageTag.safeParse(input.defaultLanguage ?? 'en');
    if (!language.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid default language');
    }
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120) {
      throw new DomainError('VALIDATION_ERROR', 'name must be 1-120 characters');
    }
    if (await this.workspaces.findBySlug(slug.data)) {
      throw new DomainError('VALIDATION_ERROR', `workspace slug already exists: ${slug.data}`, {
        objectIds: { slug: slug.data },
      });
    }

    const now = this.clock.now();
    const workspace: WorkspaceRecord = {
      id: newId('ws') as WorkspaceId,
      slug: slug.data,
      name,
      description: input.description?.trim() || null,
      defaultLanguage: language.data,
      settings: {},
      createdAt: now,
      updatedAt: now,
    };
    const systemActorId = newId('act') as ActorId;

    await this.uow.run(async (tx) => {
      await this.workspaces.insert(tx, workspace);
      await this.actors.insert(tx, {
        id: systemActorId,
        workspaceId: workspace.id,
        type: 'system',
        displayName: SYSTEM_ACTOR_NAME,
        userId: null,
        agentId: null,
        createdAt: now,
        disabledAt: null,
      });
      await this.ledger.append(
        tx,
        workspace.id,
        { actorId: systemActorId, requestId: input.requestId },
        {
          eventType: 'workspace.created',
          objectType: 'workspace',
          objectId: workspace.id,
          metadata: {
            slug: workspace.slug,
            ...(createdBy
              ? {
                  created_by_actor_id: createdBy.actorId,
                  created_by_workspace_id: createdBy.workspaceId,
                }
              : {}),
          },
        },
      );
    });
    return workspace;
  }
}
