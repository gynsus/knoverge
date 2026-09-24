import type { WorkspaceId } from '@knoverge/contracts';
import type { EmbeddingProvider } from '@knoverge/intelligence';

import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { EmbeddingProfileRecord, EmbeddingRepository } from './repository.ts';

/** How many chunks one pass embeds before it stops and asks to be called again. */
export const FILL_BATCH = 64;

export interface EmbeddingServiceOptions {
  uow: UnitOfWork;
  embeddings: EmbeddingRepository;
  /**
   * The configured provider, or null when none is.
   *
   * Null is the ordinary case, not an error: rule 9 says the core runs with no
   * AI provider, and everything here answers "nothing to do" when it is.
   */
  provider: EmbeddingProvider | null;
  clock?: Clock;
}

/** What one pass of the fill did, for a log line an operator can read. */
export interface FillReport {
  embedded: number;
  remaining: number;
  /** Set when this pass finished a rebuild and the profiles changed places. */
  promoted?: string;
}

/**
 * Vectors for chunks, under a profile that says what produced them.
 *
 * Nothing here is required for the product to work (rule 9). With no provider
 * configured there is no profile, no vector and no job; search is lexical, and
 * `workspace_manifest` says `semantic_search: false`.
 *
 * Switching models does not blank semantic search. The new profile fills as
 * `rebuilding` while the old one keeps answering, and they change places when
 * the last chunk is embedded. Otherwise a workspace of fifty thousand chunks
 * would answer nothing useful for as long as the re-embedding took.
 */
export class EmbeddingService {
  private readonly o: EmbeddingServiceOptions;
  private readonly clock: Clock;

  constructor(options: EmbeddingServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /** The profile queries should use here, or null when nothing is embedded. */
  activeProfile(workspaceId: WorkspaceId): Promise<EmbeddingProfileRecord | null> {
    return this.o.embeddings.active(workspaceId);
  }

  /**
   * Embeds what the profile is missing, up to a batch.
   *
   * Returns how many remain, so the caller can decide whether to come back
   * rather than this holding a worker for the length of a rebuild.
   */
  async fill(workspaceId: WorkspaceId, batch = FILL_BATCH): Promise<FillReport> {
    const provider = this.o.provider;
    if (!provider) return { embedded: 0, remaining: 0 };

    const profile = await this.profileFor(workspaceId, provider);
    if (!profile) return { embedded: 0, remaining: 0 };

    const pending = await this.o.embeddings.pending(workspaceId, profile.id, batch);
    if (pending.length > 0) {
      // The title goes in with the text, for the same reason it is weighted
      // into the lexical vector: a passage means something different under a
      // different heading.
      const vectors = await provider.embed(pending.map((c) => `${c.title}\n\n${c.text}`));
      const now = this.clock.now();
      await this.o.uow.run((tx) =>
        this.o.embeddings.insertMany(
          tx,
          pending.map((chunk, index) => ({
            id: newId('emb'),
            workspaceId,
            profileId: profile.id,
            chunkId: chunk.chunkId,
            vector: vectors[index] as number[],
            createdAt: now,
          })),
        ),
      );
    }

    const remaining = await this.o.embeddings.countPending(workspaceId, profile.id);
    if (remaining === 0 && profile.status === 'rebuilding') {
      const promoted = await this.promote(workspaceId, profile);
      return { embedded: pending.length, remaining, ...(promoted ? { promoted: profile.id } : {}) };
    }
    return { embedded: pending.length, remaining };
  }

  /**
   * Which profile this provider writes into.
   *
   * The active one when it is the same model. A different model gets a profile
   * of its own, in `rebuilding`, so the one answering queries keeps answering
   * until the new one is complete. The very first profile in a workspace is
   * active at once: there is nothing for it to take over from.
   */
  private async profileFor(
    workspaceId: WorkspaceId,
    provider: EmbeddingProvider,
  ): Promise<EmbeddingProfileRecord | null> {
    const active = await this.o.embeddings.active(workspaceId);
    if (active && this.matches(active, provider)) return active;

    const rebuilding = await this.o.embeddings.rebuilding(workspaceId);
    if (rebuilding && this.matches(rebuilding, provider)) return rebuilding;

    // The dimension is learned from the model's first answer, so until one
    // has been asked there is nothing to identify a profile by.
    if (provider.profile.dimensions === 0) {
      const probe = await provider.embed(['knoverge']);
      if (probe.length === 0) return null;
    }
    const { provider: name, model, dimensions } = provider.profile;
    if (dimensions === 0) return null;

    const existing = await this.o.embeddings.findProfile(workspaceId, name, model, dimensions);
    const now = this.clock.now();
    const record: EmbeddingProfileRecord = existing ?? {
      id: newId('eprof'),
      workspaceId,
      provider: name,
      model,
      dimensions,
      status: active ? 'rebuilding' : 'active',
      createdAt: now,
    };
    await this.o.uow.run(async (tx) => {
      if (!existing) {
        // A rebuilding profile from another model is abandoned rather than
        // left: two of them would each think they were the one being built.
        if (rebuilding) await this.o.embeddings.setProfileStatus(tx, rebuilding.id, 'retired');
        await this.o.embeddings.insertProfile(tx, record);
        return;
      }
      // A retired profile the operator came back to: it becomes the one being
      // built rather than the one answering, because its vectors are stale.
      if (existing.status === 'retired') {
        if (rebuilding) await this.o.embeddings.setProfileStatus(tx, rebuilding.id, 'retired');
        await this.o.embeddings.setProfileStatus(tx, existing.id, active ? 'rebuilding' : 'active');
      }
    });
    if (existing && existing.status === 'retired') {
      return { ...existing, status: active ? 'rebuilding' : 'active' };
    }
    return record;
  }

  /** The finished rebuild takes over, and the one it replaces is retired. */
  private async promote(
    workspaceId: WorkspaceId,
    profile: EmbeddingProfileRecord,
  ): Promise<boolean> {
    const active = await this.o.embeddings.active(workspaceId);
    await this.o.uow.run(async (tx) => {
      if (active) await this.o.embeddings.setProfileStatus(tx, active.id, 'retired');
      await this.o.embeddings.setProfileStatus(tx, profile.id, 'active');
    });
    return true;
  }

  private matches(profile: EmbeddingProfileRecord, provider: EmbeddingProvider): boolean {
    const wanted = provider.profile;
    if (wanted.dimensions === 0) {
      // Not asked yet: the model name is enough to recognise the profile, and
      // a dimension that turns out to differ makes a new one on the next pass.
      return profile.provider === wanted.provider && profile.model === wanted.model;
    }
    return (
      profile.provider === wanted.provider &&
      profile.model === wanted.model &&
      profile.dimensions === wanted.dimensions
    );
  }
}
