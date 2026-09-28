import type { AttachmentId, WorkspaceId } from '@knoverge/contracts';
import type { Readable } from 'node:stream';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { AttachmentRecord, AttachmentRepository } from './repository.ts';

/**
 * Where the bytes are kept.
 *
 * A port, so the domain says what a store has to do and `packages/attachments`
 * says how a filesystem does it. Nothing here knows about a path.
 */
export interface AttachmentStore {
  put(workspaceId: string, bytes: Uint8Array): Promise<{ hash: string; size: number }>;
  has(workspaceId: string, hash: string): Promise<boolean>;
  read(workspaceId: string, hash: string): Readable;
}

export interface AttachmentServiceOptions {
  uow: UnitOfWork;
  attachments: AttachmentRepository;
  store: AttachmentStore;
  ledger: EventLedger;
  /** The largest file this installation accepts, in bytes. */
  maxBytes: number;
  clock?: Clock;
}

export interface UploadAttachmentInput {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  /** Where the file came from, when the uploader said: a URL, a path, a message. */
  originalUri?: string;
}

export interface UploadResult {
  attachment: AttachmentRecord;
  /** False when this workspace already held these bytes. */
  created: boolean;
}

/**
 * What a filename may not be, whatever an uploader called it.
 *
 * A separator, because a name is shown and put in a header and is never where the
 * file is kept; and a control character, because a name with a line break in it is
 * a second header the uploader wrote.
 */
function unsafeFilename(name: string): boolean {
  if (name.includes('/') || name.includes('\\')) return true;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Files a workspace holds, and nothing about what they mean.
 *
 * An attachment is not knowledge. What a file *says* becomes a `document` item
 * with the usual provenance, review and history; this service is only concerned
 * with the bytes arriving, being kept once, and being handed back (ADR 0008).
 *
 * Deduplication is per workspace and by content: the same file uploaded twice is
 * one attachment with one id. Not across workspaces, because "you already have
 * this" is an answer that would tell one workspace what another holds.
 */
export class AttachmentService {
  private readonly o: AttachmentServiceOptions;
  private readonly clock: Clock;

  constructor(options: AttachmentServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Takes a file in.
   *
   * The bytes are written before the row, and that order is deliberate: a file on
   * disk with no row is a few kilobytes nobody asked for, and a row with no file
   * is a record of something that is not there — which is what the integrity
   * check reports and an operator cannot fix.
   */
  async upload(actor: ActorContext, input: UploadAttachmentInput): Promise<UploadResult> {
    const filename = input.filename.trim();
    if (filename === '' || unsafeFilename(filename)) {
      throw new DomainError('VALIDATION_ERROR', 'a filename cannot be empty or contain a path');
    }
    if (input.bytes.byteLength === 0) {
      throw new DomainError('VALIDATION_ERROR', 'an empty file says nothing and is not stored');
    }
    if (input.bytes.byteLength > this.o.maxBytes) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `this installation accepts files up to ${this.o.maxBytes} bytes`,
      );
    }

    const stored = await this.o.store.put(actor.workspaceId, input.bytes);
    const existing = await this.o.attachments.findByHash(actor.workspaceId, stored.hash);
    // The row decides, not the file: the bytes can be on disk with no row after a
    // restore from a backup taken mid-upload, and answering from the file would
    // hand back an attachment id that does not exist.
    if (existing) return { attachment: existing, created: false };

    const attachment: AttachmentRecord = {
      id: newId('att') as AttachmentId,
      workspaceId: actor.workspaceId,
      contentHash: stored.hash,
      mediaType: input.mediaType,
      sizeBytes: stored.size,
      filename,
      originalUri: input.originalUri?.trim() || null,
      // Nothing has read it yet. What becomes of the text is Milestone 11's
      // extraction job, and until it runs this says so rather than guessing.
      extractionState: 'pending',
      extractionError: null,
      extractionStartedAt: null,
      uploadedByActorId: actor.actorId,
      createdAt: this.clock.now(),
    };

    await this.o.uow.run(async (tx) => {
      await this.o.attachments.insert(tx, attachment);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'attachment.uploaded',
        objectType: 'attachment',
        objectId: attachment.id,
        metadata: {
          // What it is and how big, and never what it is called: a filename is
          // the uploader's words and can say as much as the file does
          // ("resignation-2026.pdf"), and the ledger holds safe metadata only.
          media_type: attachment.mediaType,
          size_bytes: attachment.sizeBytes,
          content_hash: attachment.contentHash,
        },
      });
    });

    return { attachment, created: true };
  }

  async list(workspaceId: WorkspaceId, limit = 200): Promise<AttachmentRecord[]> {
    return this.o.attachments.list(workspaceId, limit);
  }

  /**
   * Ask for files to be read again.
   *
   * The sweep only ever looks at files nobody has read yet, which is right until
   * something changes underneath it: a vision model assigned in April cannot
   * describe the picture that arrived in March, and a provider unreachable for a
   * minute leaves a file `failed` for good. This is the way back into the queue,
   * and the reading itself is the ordinary one.
   *
   * Only `unsupported` and `failed`. Asking for one that is neither says so
   * rather than answering zero, because "nothing happened" and "that is not a
   * thing to ask for" are different answers to somebody who just pressed a
   * button.
   *
   * Not a ledger event. What is recorded is what happens to knowledge, and this
   * changes a row from one kind of "no text yet" to another; the write it may
   * lead to records itself, as every write does.
   */
  async reread(workspaceId: WorkspaceId, id?: AttachmentId): Promise<number> {
    if (id !== undefined) {
      const attachment = await this.get(workspaceId, id);
      if (attachment.extractionState !== 'unsupported' && attachment.extractionState !== 'failed') {
        throw new DomainError(
          'VALIDATION_ERROR',
          `this file is ${attachment.extractionState}; only a file that was not read can be read again`,
          { objectIds: { attachment: id } },
        );
      }
    }
    return this.o.attachments.requeue(workspaceId, id);
  }

  async get(workspaceId: WorkspaceId, id: AttachmentId): Promise<AttachmentRecord> {
    const attachment = await this.o.attachments.findById(workspaceId, id);
    if (!attachment) {
      throw new DomainError('NOT_FOUND', 'no attachment with that id', {
        objectIds: { attachment: id },
      });
    }
    return attachment;
  }

  /**
   * The file itself, for a caller that is going to send it somewhere.
   *
   * A stream, because the caller is a response and an installation should be able
   * to serve a large file without holding one in memory per reader. A row whose
   * file is missing is a `NOT_FOUND` rather than a stream that errors halfway
   * through a response nobody can take back.
   */
  async open(
    workspaceId: WorkspaceId,
    id: AttachmentId,
  ): Promise<{ attachment: AttachmentRecord; body: Readable }> {
    const attachment = await this.get(workspaceId, id);
    if (!(await this.o.store.has(workspaceId, attachment.contentHash))) {
      throw new DomainError('NOT_FOUND', 'the file for this attachment is not in the store', {
        objectIds: { attachment: id },
      });
    }
    return { attachment, body: this.o.store.read(workspaceId, attachment.contentHash) };
  }

  /** Whether the bytes a row claims are actually there. The integrity check asks. */
  async holds(attachment: AttachmentRecord): Promise<boolean> {
    return this.o.store.has(attachment.workspaceId, attachment.contentHash);
  }
}
