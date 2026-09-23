import type {
  AgentId,
  CategoryId,
  ClassificationState,
  KnowledgeItemId,
  MatchReason,
  SyncBeginInput,
  SyncCandidateInput,
  SyncClassification,
  WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { DuplicateRow, KnowledgeRepository } from '../knowledge/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type {
  AgentSyncStateRecord,
  SyncCandidateRecord,
  SyncRepository,
  SyncSessionRecord,
} from './repository.ts';

/** How long an agent has to finish a pass before it has to start again. */
export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** What one candidate was decided to be, before it is written down. */
export interface Decision {
  classification: SyncClassification;
  state: ClassificationState;
  reason: MatchReason;
  matched: KnowledgeItemId[];
  explanation: string;
}

export interface SyncServiceOptions {
  uow: UnitOfWork;
  sync: SyncRepository;
  items: KnowledgeRepository;
  /** Resolves category paths to ids, because a path is not an identity. */
  categories: {
    list(
      workspaceId: WorkspaceId,
      options?: { includeArchived?: boolean },
    ): Promise<{ id: CategoryId; path: string }[]>;
  };
  clock?: Clock;
}

/**
 * Reconciling what an agent already knows against what the workspace holds.
 *
 * The product exists so that a newly connected agent does not record what is
 * already recorded. Checking one write at a time is the half of that which
 * already worked; this is the other half — an agent offers an inventory of
 * everything it believes it knows, and learns which of it the workspace has,
 * before writing anything.
 *
 * Nothing here decides that two things are the same. It decides what the agent
 * should look at, and the agent decides. Every classification carries the
 * reason, so an agent can act on it rather than trust it.
 */
export class SyncService {
  private readonly o: SyncServiceOptions;
  private readonly clock: Clock;

  constructor(options: SyncServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Opens a pass, and says where the agent left off last time.
   *
   * A session belongs to an agent: a person reconciling their own memory
   * against the workspace is not a thing this protocol describes, and the
   * checkpoint it writes is keyed by agent and source.
   */
  async begin(
    actor: ActorContext,
    input: SyncBeginInput,
    context: { taxonomyVersion: number; changeSequence: number },
  ): Promise<SyncSessionRecord> {
    const agentId = this.requireAgent(actor);
    const namespace = input.source_namespace ?? null;

    if (input.previous_sync_id) {
      const existing = await this.o.sync.findSession(actor.workspaceId, input.previous_sync_id);
      if (!existing) throw new DomainError('NOT_FOUND', 'no such sync session');
      if (existing.agentId !== agentId) {
        throw new DomainError('FORBIDDEN', 'that sync session belongs to another agent');
      }
      if (existing.state === 'completed') {
        throw new DomainError('VALIDATION_ERROR', 'that sync session is already complete');
      }
      if (existing.expiresAt <= this.clock.now()) {
        throw new DomainError('SYNC_SESSION_EXPIRED', 'that sync session has expired');
      }
      return existing;
    }

    const now = this.clock.now();
    const session: SyncSessionRecord = {
      id: newId('sync'),
      workspaceId: actor.workspaceId,
      agentId,
      sourceSystem: input.source_system,
      sourceNamespace: namespace,
      state: 'open',
      taxonomyVersion: context.taxonomyVersion,
      changeSequenceAtStart: context.changeSequence,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
      completedAt: null,
      stats: {},
    };
    await this.o.uow.run((tx) => this.o.sync.insertSession(tx, session));
    return session;
  }

  /** The checkpoint this agent reached for this source, if it ever did. */
  previousCheckpoint(
    actor: ActorContext,
    source: { system: string; namespace: string | null },
  ): Promise<AgentSyncStateRecord | null> {
    return this.o.sync.findState(actor.workspaceId, this.requireAgent(actor), source);
  }

  /**
   * Classifies a batch and records it.
   *
   * Everything here is synchronous and deterministic: external identity, then
   * content hash, then freshness where the lineage is known. Anything left
   * over is `provisional` and waits for the lexical pass, so an agent polling
   * for `final` knows the difference between "nothing matches" and "nothing
   * has looked yet".
   */
  async submitInventory(
    actor: ActorContext,
    sessionId: string,
    candidates: readonly SyncCandidateInput[],
    /** Items this caller may read. A match outside it is not a match it hears about. */
    readable: (itemIds: readonly KnowledgeItemId[]) => Promise<Set<string>>,
  ): Promise<{ session: SyncSessionRecord; records: SyncCandidateRecord[] }> {
    const session = await this.requireOpenSession(actor, sessionId);
    const now = this.clock.now();

    const categories = await this.o.categories.list(actor.workspaceId, { includeArchived: true });
    const idOfPath = new Map(categories.map((c) => [c.path, c.id]));
    const keys = candidates.map((c) => c.external_key).filter((k): k is string => k !== undefined);
    const previous = await this.o.sync.previousCandidates(
      actor.workspaceId,
      session.agentId,
      { system: session.sourceSystem, namespace: session.sourceNamespace },
      keys,
    );

    const records: SyncCandidateRecord[] = [];
    for (const candidate of candidates) {
      const decision = await this.classify(
        actor.workspaceId,
        session,
        candidate,
        idOfPath,
        previous,
        readable,
      );
      records.push({
        id: newId('cand'),
        syncSessionId: session.id,
        clientCandidateId: candidate.client_candidate_id,
        externalKey: candidate.external_key ?? null,
        sourceContentHash: candidate.source_content_hash ?? null,
        candidateContentHash: candidate.candidate_content_hash ?? null,
        sourceModifiedAt: candidate.source_modified_at
          ? new Date(candidate.source_modified_at)
          : null,
        title: candidate.title,
        knowledgeType: candidate.type,
        language: candidate.language ?? null,
        proposedCategoryPaths: [...candidate.proposed_category_paths],
        abstract: candidate.abstract ?? null,
        classification: decision.classification,
        classificationState: decision.state,
        matchReason: decision.reason,
        matchedItemIds: decision.matched,
        serverReason: { explanation: decision.explanation },
        createdAt: now,
        updatedAt: now,
      });
    }

    await this.o.uow.run(async (tx) => {
      await this.o.sync.upsertCandidates(tx, records);
      await this.o.sync.updateSession(tx, session.id, { state: 'waiting_for_agent' });
    });
    return { session, records };
  }

  /**
   * Writes the checkpoint, so the next pass sends only what changed.
   *
   * The position recorded is where the change feed stood when the session
   * opened, not where it stands now: anything committed while the agent was
   * working is a change the agent has not seen, and starting the next pass
   * after it would skip exactly that.
   */
  async complete(actor: ActorContext, sessionId: string): Promise<SyncSessionRecord> {
    const session = await this.requireSession(actor, sessionId);
    if (session.state === 'completed') return session;
    const counts = await this.o.sync.countCandidates(session.id);
    const now = this.clock.now();
    const completed: SyncSessionRecord = {
      ...session,
      state: 'completed',
      completedAt: now,
      stats: { ...counts.byClassification, total: counts.total, pending: counts.pending },
    };
    const existing = await this.o.sync.findState(actor.workspaceId, session.agentId, {
      system: session.sourceSystem,
      namespace: session.sourceNamespace,
    });
    await this.o.uow.run(async (tx) => {
      await this.o.sync.updateSession(tx, session.id, {
        state: 'completed',
        completedAt: now,
        stats: completed.stats,
      });
      await this.o.sync.upsertState(tx, {
        id: existing?.id ?? newId('ast'),
        workspaceId: actor.workspaceId,
        agentId: session.agentId,
        sourceSystem: session.sourceSystem,
        sourceNamespace: session.sourceNamespace,
        lastCompletedSyncId: session.id,
        lastChangeSequence: session.changeSequenceAtStart,
        lastTaxonomyVersion: session.taxonomyVersion,
        lastCompletedAt: now,
      });
    });
    return completed;
  }

  async requireSession(actor: ActorContext, sessionId: string): Promise<SyncSessionRecord> {
    const session = await this.o.sync.findSession(actor.workspaceId, sessionId);
    if (!session) throw new DomainError('NOT_FOUND', 'no such sync session');
    // Another agent's session is not this agent's to read: its candidates are
    // an inventory of what that agent knows.
    if (session.agentId !== this.requireAgent(actor)) {
      throw new DomainError('FORBIDDEN', 'that sync session belongs to another agent');
    }
    return session;
  }

  private async requireOpenSession(
    actor: ActorContext,
    sessionId: string,
  ): Promise<SyncSessionRecord> {
    const session = await this.requireSession(actor, sessionId);
    if (session.state === 'completed') {
      throw new DomainError('VALIDATION_ERROR', 'that sync session is already complete');
    }
    if (session.expiresAt <= this.clock.now()) {
      throw new DomainError('SYNC_SESSION_EXPIRED', 'that sync session has expired; begin another');
    }
    return session;
  }

  private requireAgent(actor: ActorContext): AgentId {
    if (actor.actorType !== 'agent' || !actor.agentId) {
      throw new DomainError(
        'FORBIDDEN',
        'reconciliation is an agent protocol; a sync session belongs to an agent',
      );
    }
    return actor.agentId as AgentId;
  }

  /**
   * Steps A, B and F of the matcher.
   *
   * Step C — deterministic title, type and category filters — and step D,
   * lexical similarity, leave the candidate provisional. Step E needs an
   * embedding profile and arrives with one.
   */
  private async classify(
    workspaceId: WorkspaceId,
    session: SyncSessionRecord,
    candidate: SyncCandidateInput,
    idOfPath: Map<string, CategoryId>,
    previous: Map<string, SyncCandidateRecord>,
    readable: (itemIds: readonly KnowledgeItemId[]) => Promise<Set<string>>,
  ): Promise<Decision> {
    // Step A. External identity, which is the only lineage this protocol can
    // be sure of: the agent and the workspace agree on a name for the source.
    if (candidate.external_key) {
      const existing = await this.o.items.findByExternal(
        workspaceId,
        session.sourceSystem,
        candidate.external_key,
      );
      if (existing && (await readable([existing.id])).has(existing.id)) {
        const before = previous.get(candidate.external_key);
        const unchanged =
          candidate.source_content_hash !== undefined &&
          before?.sourceContentHash === candidate.source_content_hash;
        if (unchanged) {
          return {
            classification: 'exact_known',
            state: 'final',
            reason: 'external_key',
            matched: [existing.id],
            explanation: 'the workspace holds this and your source has not changed since; skip it',
          };
        }
        return this.freshness(candidate, existing.updatedAt, existing.id);
      }
    }

    // Step B. The same text. In the same place it is the same knowledge; in a
    // different one it may not be — the same instruction in two projects is
    // two instructions — so that is a question rather than an answer.
    if (candidate.candidate_content_hash) {
      const rows = await this.o.items.findByContentHash(
        workspaceId,
        candidate.candidate_content_hash,
      );
      const allowed = await readable(rows.map((r) => r.itemId));
      const visible = rows.filter((r) => allowed.has(r.itemId));
      if (visible.length > 0) {
        const primary = candidate.proposed_category_paths[0];
        const wanted = primary ? (idOfPath.get(primary) ?? null) : null;
        const sameScope = visible.filter(
          (r: DuplicateRow) => r.type === candidate.type && r.primaryCategoryId === wanted,
        );
        if (sameScope.length > 0) {
          return {
            classification: 'exact_known',
            state: 'final',
            reason: 'content_hash',
            matched: sameScope.map((r) => r.itemId),
            explanation: 'the workspace holds this exact text in the same place; skip it',
          };
        }
        return {
          classification: 'likely_match',
          state: 'final',
          reason: 'content_hash',
          matched: visible.map((r) => r.itemId),
          explanation:
            'the workspace holds this exact text somewhere else; read those items and decide whether yours is the same knowledge',
        };
      }
    }

    // Steps C and D have not run. Saying `new_candidate` and `final` here
    // would tell an agent nothing matches when nothing has looked.
    return {
      classification: 'new_candidate',
      state: 'provisional',
      reason: 'none',
      matched: [],
      explanation: 'no deterministic match; a similarity pass has not run yet',
    };
  }

  /**
   * Step F. Which side is newer, when the lineage is known.
   *
   * Only reached through an external key, because that is the one case where
   * both sides agree they are talking about the same thing. Without a time
   * from the agent there is nothing to compare, and a wall-clock guess would
   * be worse than saying so: old text copied into a new file carries today's
   * date.
   */
  private freshness(
    candidate: SyncCandidateInput,
    canonicalUpdatedAt: Date,
    itemId: KnowledgeItemId,
  ): Decision {
    const base = {
      state: 'final' as const,
      reason: 'external_key' as const,
      matched: [itemId],
    };
    if (!candidate.source_modified_at) {
      return {
        ...base,
        classification: 'conflict',
        explanation:
          'the workspace holds this under the same external key and your source has changed, but you sent no modification time, so neither side can be called newer; read the item and propose a change that says what differs',
      };
    }
    const mine = new Date(candidate.source_modified_at).getTime();
    const theirs = canonicalUpdatedAt.getTime();
    if (mine > theirs) {
      return {
        ...base,
        classification: 'server_copy_stale',
        explanation:
          'yours is newer; read the item and propose an update against its revision and content hash',
      };
    }
    if (theirs > mine) {
      return {
        ...base,
        classification: 'agent_copy_stale',
        explanation: 'the workspace is ahead of you; do not propose your copy, take theirs',
      };
    }
    return {
      ...base,
      classification: 'conflict',
      explanation:
        'both sides changed and carry the same time, so neither is newer; read the item and propose a change that says what differs',
    };
  }
}
