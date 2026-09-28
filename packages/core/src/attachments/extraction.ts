import type { AgentId, AttachmentId, ExtractionState, WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import type { ActorStanding } from '../authorization/service.ts';
import type { KnowledgeService } from '../knowledge/service.ts';
import type { ProposalService } from '../proposals/service.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { ActorRepository } from '../workspace/repository.ts';
import type { Description } from './description.ts';
import type { Transcript } from './transcription.ts';
import type { AttachmentRecord, AttachmentRepository } from './repository.ts';
import type { AttachmentStore } from './service.ts';

/** What a file turned out to hold, as the store package answers it. */
export type Extraction =
  | { kind: 'text'; text: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed'; reason: string };

export interface AttachmentExtractorOptions {
  attachments: AttachmentRepository;
  actors: ActorRepository;
  /**
   * What the uploader's role or trust tier is, which the policy reads.
   *
   * Supplied rather than looked up here: the server already answers this for a
   * request, and a second answer computed from two more repositories would be a
   * second policy input that could disagree with the first.
   */
  standingOf: (actor: ActorContext) => Promise<ActorStanding>;
  store: AttachmentStore;
  knowledge: KnowledgeService;
  proposals: ProposalService;
  /** Bytes and a media type in, text or a reason out. No provider, no network. */
  extract: (
    mediaType: string,
    bytes: Uint8Array,
    maxCharacters: number,
  ) => Extraction | Promise<Extraction>;
  /**
   * A model that can look at a picture, when the installation has one.
   *
   * Asked only about what nothing here can read on its own, and only after that
   * answer is in: reading is free and looking is somebody else's GPU. Null when
   * no vision model is assigned, which leaves the file exactly where it was —
   * kept, downloadable, and `unsupported` (rule 9).
   */
  describe?: (mediaType: string, bytes: Uint8Array) => Promise<Description | null>;
  /**
   * A model that can listen to a recording, when the installation has one.
   *
   * Asked on the same terms as the describer, and answering null leaves the file
   * where it was: kept, downloadable and `unsupported`.
   */
  transcribe?: (
    mediaType: string,
    bytes: Uint8Array,
    filename: string,
  ) => Promise<Transcript | null>;
  /** The most one knowledge item may hold. */
  maxCharacters: number;
  clock?: Clock;
}

export interface ExtractionOutcome {
  attachmentId: AttachmentId;
  state: ExtractionState;
  /** The item, when one was written. Null when a reviewer has it instead. */
  itemId: string | null;
  reason?: string;
}

/** What a file's text is filed under when nobody has said otherwise. */
export const DOCUMENT_TYPE = 'document' as const;

/**
 * How long a claim is believed.
 *
 * Long enough that a slow file is not taken twice, short enough that a worker
 * killed mid-read does not strand a file until somebody notices.
 */
export const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Turning a file into knowledge somebody can find.
 *
 * The text of a file becomes an ordinary `document` item: it is searched,
 * reviewed, superseded and versioned like anything else, and it says where it
 * came from through a source of type `attachment` carrying the attachment's id
 * and the hash of the bytes it was read from. That source is the link — there is
 * no column pointing back, because the item already carries the fact and the
 * frontmatter carries it portably (ADR 0008).
 *
 * The write is made **as the person or agent who uploaded the file**, and that is
 * the whole of the policy question. A person who may write knowledge writes it. An
 * agent proposes, and its document waits for a reviewer exactly as its other
 * writes do — a file is not a way around rule 5.
 */
export class AttachmentExtractor {
  private readonly o: AttachmentExtractorOptions;
  private readonly clock: Clock;

  constructor(options: AttachmentExtractorOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * One pass over the files nobody has read yet.
   *
   * Each is claimed before it is read, and a claim is a state change: two workers
   * sweeping at the same minute cannot both take one file and write the same
   * document twice. A file whose worker died is claimed again once its claim is
   * older than `STALE_CLAIM_MS`.
   */
  async extractPending(limit = 20): Promise<ExtractionOutcome[]> {
    const now = this.clock.now();
    const claimed = await this.o.attachments.claimUnread(
      limit,
      new Date(now.getTime() - STALE_CLAIM_MS),
      now,
    );
    const outcomes: ExtractionOutcome[] = [];
    for (const attachment of claimed) outcomes.push(await this.extract(attachment));
    return outcomes;
  }

  /**
   * One file.
   *
   * Every ending is recorded on the row, including the ones that are not
   * failures: `unsupported` is an answer, and a file that stays `pending` because
   * the sweep keeps crashing on it is the one state this must never leave behind.
   */
  async extract(attachment: AttachmentRecord): Promise<ExtractionOutcome> {
    try {
      return await this.run(attachment);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.settle(attachment, 'failed', reason);
      return { attachmentId: attachment.id, state: 'failed', itemId: null, reason };
    }
  }

  private async run(attachment: AttachmentRecord): Promise<ExtractionOutcome> {
    if (!(await this.o.store.has(attachment.workspaceId, attachment.contentHash))) {
      throw new DomainError('NOT_FOUND', 'the file for this attachment is not in the store');
    }
    const bytes = await this.bytes(attachment);
    const read = await this.o.extract(attachment.mediaType, bytes, this.o.maxCharacters);
    // Nothing here could read it, so ask whatever can look at it. A description
    // is a model's words about somebody's picture, so the item it becomes says
    // which model wrote them (ADR 0031).
    const asked = read.kind === 'unsupported' ? await this.ask(attachment, bytes) : null;
    const found: Extraction = asked ? { kind: 'text', text: asked.text } : read;
    if (found.kind !== 'text') {
      await this.settle(attachment, found.kind, found.reason);
      return {
        attachmentId: attachment.id,
        state: found.kind,
        itemId: null,
        reason: found.reason,
      };
    }

    const actor = await this.actorFor(attachment);
    const input = {
      title: titleOf(attachment.filename),
      body: found.text.endsWith('\n') ? found.text : `${found.text}\n`,
      type: DOCUMENT_TYPE,
      ...(asked ? { draftedBy: asked.model } : {}),
      sources: [
        {
          type: 'attachment' as const,
          // How this installation identifies the file, and the hash of the bytes
          // the text was read from. Together they say which file and which
          // version of it — and they stay true in a repository read without any
          // of this software.
          external_key: attachment.id,
          content_hash: attachment.contentHash,
          ...(attachment.originalUri ? { uri: attachment.originalUri } : {}),
          role: 'primary' as const,
        },
      ],
    };

    if (actor.actorType === 'agent') {
      // The same door every other agent write goes through: the policy decides
      // whether this waits for a reviewer, and the duplicate check runs, so a
      // file uploaded twice does not become a second document (rule 5, rule 14).
      const outcome = await this.o.proposals.proposeCreate(
        actor,
        await this.o.standingOf(actor),
        input,
      );
      const wrote = outcome.itemId !== null;
      await this.settle(attachment, wrote ? 'extracted' : 'proposed', null);
      return {
        attachmentId: attachment.id,
        state: wrote ? 'extracted' : 'proposed',
        itemId: outcome.itemId,
      };
    }

    const result = await this.o.knowledge.create(actor, input);
    await this.settle(attachment, 'extracted', null);
    return { attachmentId: attachment.id, state: 'extracted', itemId: result.item.id };
  }

  /**
   * Whatever can be asked about a file nothing here could read.
   *
   * One or the other, never both: a picture is looked at and a recording is
   * listened to, and a file that is neither is simply kept.
   */
  private async ask(
    attachment: AttachmentRecord,
    bytes: Uint8Array,
  ): Promise<Description | Transcript | null> {
    if (this.o.describe) {
      const described = await this.o.describe(attachment.mediaType, bytes);
      if (described) return described;
    }
    if (this.o.transcribe) {
      return this.o.transcribe(attachment.mediaType, bytes, attachment.filename);
    }
    return null;
  }

  private async bytes(attachment: AttachmentRecord): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.o.store.read(attachment.workspaceId, attachment.contentHash)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /**
   * The context the write is made in.
   *
   * The uploader, not the server: the item's provenance says who brought the file
   * in, and a write attributed to nobody would be the one write in this product
   * that cannot be traced to somebody (rule 3).
   */
  private async actorFor(attachment: AttachmentRecord): Promise<ActorContext> {
    const actor = await this.o.actors.findById(
      attachment.workspaceId,
      attachment.uploadedByActorId,
    );
    if (!actor) {
      throw new DomainError('NOT_FOUND', 'the actor that uploaded this attachment is gone');
    }
    if (actor.disabledAt) {
      throw new DomainError('FORBIDDEN', 'the actor that uploaded this attachment is disabled');
    }
    return {
      workspaceId: attachment.workspaceId,
      actorId: actor.id,
      actorType: actor.type,
      ...(actor.agentId ? { agentId: actor.agentId as AgentId } : {}),
      // Not a request: a sweep, named so the ledger says which file it was for.
      requestId: `attachment-extract:${attachment.id}`,
    };
  }

  private async settle(
    attachment: AttachmentRecord,
    state: ExtractionState,
    error: string | null,
  ): Promise<void> {
    await this.o.attachments.setExtraction(
      attachment.workspaceId as WorkspaceId,
      attachment.id,
      state,
      error,
    );
  }
}

/**
 * What the item is called.
 *
 * The filename without its extension, which is what somebody named the thing.
 * A title is the one field a reader scans, and `report-2026.pdf` reads better as
 * "report-2026" than as a sentence invented from the first line of the text.
 */
export function titleOf(filename: string): string {
  const withoutExtension = filename.replace(/\.[A-Za-z0-9]{1,12}$/u, '');
  const title = (withoutExtension || filename).trim();
  return title.length > 200 ? `${title.slice(0, 197)}...` : title;
}
