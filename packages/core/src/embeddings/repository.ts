import type { WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export type EmbeddingProfileStatus = 'active' | 'rebuilding' | 'retired';

export interface EmbeddingProfileRecord {
  id: string;
  workspaceId: WorkspaceId;
  provider: string;
  model: string;
  dimensions: number;
  status: EmbeddingProfileStatus;
  createdAt: Date;
}

/** A chunk waiting for a vector, with the text to compute it from. */
export interface PendingChunk {
  chunkId: string;
  title: string;
  text: string;
}

export interface EmbeddingRepository {
  /** The profile answering queries here, or null when nothing is embedded. */
  active(workspaceId: WorkspaceId): Promise<EmbeddingProfileRecord | null>;
  /** The profile being filled, if one is. */
  rebuilding(workspaceId: WorkspaceId): Promise<EmbeddingProfileRecord | null>;
  /** By what it is, so the same model is never given two profiles. */
  findProfile(
    workspaceId: WorkspaceId,
    provider: string,
    model: string,
    dimensions: number,
  ): Promise<EmbeddingProfileRecord | null>;
  insertProfile(tx: Tx, profile: EmbeddingProfileRecord): Promise<void>;
  setProfileStatus(tx: Tx, profileId: string, status: EmbeddingProfileStatus): Promise<void>;
  /** Chunks this profile has no vector for, oldest first, at most `limit`. */
  pending(workspaceId: WorkspaceId, profileId: string, limit: number): Promise<PendingChunk[]>;
  /** How many chunks still have no vector under this profile. */
  countPending(workspaceId: WorkspaceId, profileId: string): Promise<number>;
  insertMany(
    tx: Tx,
    rows: readonly {
      id: string;
      workspaceId: WorkspaceId;
      profileId: string;
      chunkId: string;
      vector: number[];
      createdAt: Date;
    }[],
  ): Promise<void>;
}
