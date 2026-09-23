import type {
  AgentId,
  ClassificationState,
  MatchReason,
  SyncClassification,
  SyncSessionState,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface SyncSessionRecord {
  id: string;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  sourceSystem: string;
  sourceNamespace: string | null;
  state: SyncSessionState;
  taxonomyVersion: number;
  changeSequenceAtStart: number;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  stats: Record<string, number>;
}

export interface SyncCandidateRecord {
  id: string;
  syncSessionId: string;
  clientCandidateId: string;
  externalKey: string | null;
  sourceContentHash: string | null;
  candidateContentHash: string | null;
  sourceModifiedAt: Date | null;
  title: string;
  knowledgeType: string;
  language: string | null;
  proposedCategoryPaths: string[];
  abstract: string | null;
  classification: SyncClassification;
  classificationState: ClassificationState;
  matchReason: MatchReason;
  matchedItemIds: string[];
  serverReason: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSyncStateRecord {
  id: string;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  sourceSystem: string;
  sourceNamespace: string | null;
  lastCompletedSyncId: string | null;
  lastChangeSequence: number | null;
  lastTaxonomyVersion: number | null;
  lastCompletedAt: Date | null;
}

export interface SyncRepository {
  insertSession(tx: Tx, session: SyncSessionRecord): Promise<void>;
  findSession(workspaceId: WorkspaceId, id: string): Promise<SyncSessionRecord | null>;
  updateSession(
    tx: Tx,
    id: string,
    patch: Partial<Pick<SyncSessionRecord, 'state' | 'completedAt' | 'stats'>>,
  ): Promise<void>;

  /**
   * Writes a batch, replacing any candidate already under the same client id.
   *
   * A resubmitted batch is the same batch: the key inside a session is
   * `sync_session_id + client_candidate_id`, so a retry after a dropped
   * response updates rather than duplicating.
   */
  upsertCandidates(tx: Tx, candidates: readonly SyncCandidateRecord[]): Promise<void>;
  listCandidates(
    syncSessionId: string,
    options: {
      onlyFinal?: boolean;
      /** The ones a background pass still owes an answer for. */
      onlyProvisional?: boolean;
      after?: string;
      limit: number;
    },
  ): Promise<SyncCandidateRecord[]>;
  /** Counts by classification, and how many are still provisional. */
  countCandidates(
    syncSessionId: string,
  ): Promise<{ byClassification: Record<string, number>; pending: number; total: number }>;

  /**
   * What this agent last said about these external keys, in a session it
   * finished.
   *
   * The answer to "did my source change since the last checkpoint": a key
   * whose `source_content_hash` is what it was is a source that has not
   * moved. Only completed sessions count, because an abandoned one recorded
   * an intention rather than a fact.
   */
  previousCandidates(
    workspaceId: WorkspaceId,
    agentId: AgentId,
    source: { system: string; namespace: string | null },
    externalKeys: readonly string[],
  ): Promise<Map<string, SyncCandidateRecord>>;

  /** Every pass in the workspace, newest first, for a person reading them. */
  listSessions(workspaceId: WorkspaceId, limit: number): Promise<SyncSessionRecord[]>;
  /** Counts by classification for several sessions at once. */
  countForSessions(
    sessionIds: readonly string[],
  ): Promise<
    Map<string, { byClassification: Record<string, number>; pending: number; total: number }>
  >;

  /**
   * Drops the candidates of passes finished before a date, and answers how
   * many it dropped.
   *
   * The session row stays: its stats were written when it completed, so the
   * run is still readable as a run. What goes is the per-candidate detail,
   * which is where an agent's own text about its material lives and which
   * nothing reads once the pass is over.
   */
  deleteCandidatesCompletedBefore(tx: Tx, before: Date): Promise<number>;

  findState(
    workspaceId: WorkspaceId,
    agentId: AgentId,
    source: { system: string; namespace: string | null },
  ): Promise<AgentSyncStateRecord | null>;
  upsertState(tx: Tx, state: AgentSyncStateRecord): Promise<void>;
}
