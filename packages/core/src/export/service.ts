import type { AttachmentId, WorkspaceId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { AttachmentRepository } from '../attachments/repository.ts';
import type { EventRepository } from '../ledger/repository.ts';
import type { KnowledgeRepository } from '../knowledge/repository.ts';
import type { ActorRepository, WorkspaceRepository } from '../workspace/repository.ts';

/**
 * What an export says about itself.
 *
 * Read by an import, and by a person with a text editor: this is the only part of
 * an export that is not already readable as Markdown, so it says what the files
 * cannot rather than repeating what they do (ADR 0034).
 */
export interface ExportManifest {
  /**
   * What this file is and how to read it.
   *
   * A number and not a range: an import that meets a version it does not know
   * refuses, rather than guessing which half of a newer shape it understands.
   */
  format: 'knoverge-workspace-export';
  format_version: 1;
  taken_at: string;
  taken_by: string;
  workspace: {
    id: string;
    slug: string;
    name: string;
    default_language: string;
    created_at: string;
  };
  /**
   * Where the ledger stood when this was taken.
   *
   * Not the events themselves — their chain is keyed with a key that never
   * leaves the installation, so they cannot be verified anywhere else (rule 4,
   * ADR 0034). The number is a statement about what this export is a picture of.
   */
  ledger_sequence: number;
  /** How much there is, so an import can say what it is about to do. */
  counts: { items: number; attachments: number; actors: number };
  /**
   * Who the commit trailers name.
   *
   * Names and kinds, never addresses: a commit says `act_01…`, and an export
   * handed to somebody else should let them read who that was without carrying
   * anybody's sign-in address out of the installation.
   */
  actors: { id: string; type: string; display_name: string }[];
  /**
   * Every file the workspace holds, and whether its bytes came along.
   *
   * Listed either way. An attachment is not in Git and cannot be rebuilt from
   * anything (ADR 0008), so an export without the bytes leaves items whose
   * sources point at nothing — and an import that can name what is missing is
   * better than one that discovers it later.
   */
  attachments: {
    id: string;
    filename: string;
    media_type: string;
    size_bytes: number;
    content_hash: string;
    included: boolean;
  }[];
}

export interface ExportServiceOptions {
  workspaces: WorkspaceRepository;
  actors: ActorRepository;
  knowledge: KnowledgeRepository;
  attachments: AttachmentRepository;
  events: EventRepository;
  clock?: Clock;
}

/** Everything in one place, so two callers cannot disagree about what a file is. */
export interface AttachmentToCopy {
  id: AttachmentId;
  contentHash: string;
}

/**
 * What goes into an export of one workspace.
 *
 * The decisions are here and the file writing is in the command line, because
 * *what an export contains* is a rule about this product and *where the bytes
 * land* is not. ADR 0034 says what is left out and why each omission is a
 * decision rather than an oversight.
 */
export class ExportService {
  private readonly o: ExportServiceOptions;
  private readonly clock: Clock;

  constructor(options: ExportServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * The manifest, and the attachments an export would copy.
   *
   * Read together and in one call, so the list in the manifest and the files on
   * disk describe the same set. `withAttachments` decides whether the bytes are
   * carried; the list is the same either way.
   */
  async describe(
    workspaceId: WorkspaceId,
    options: { takenBy: string; withAttachments: boolean },
  ): Promise<{ manifest: ExportManifest; copy: AttachmentToCopy[] }> {
    const workspace = await this.o.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new DomainError('NOT_FOUND', 'no workspace with that id', {
        objectIds: { workspace: workspaceId },
      });
    }
    const [actors, held, items, sequence] = await Promise.all([
      this.o.actors.listForWorkspace(workspaceId),
      this.o.attachments.list(workspaceId, ATTACHMENT_LIMIT),
      this.o.knowledge.countFor(workspaceId),
      this.o.events.latestSequence(workspaceId),
    ]);

    const manifest: ExportManifest = {
      format: 'knoverge-workspace-export',
      format_version: FORMAT_VERSION,
      taken_at: this.clock.now().toISOString(),
      taken_by: options.takenBy,
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        default_language: workspace.defaultLanguage,
        created_at: workspace.createdAt.toISOString(),
      },
      ledger_sequence: sequence,
      counts: { items, attachments: held.length, actors: actors.length },
      actors: actors.map((actor) => ({
        id: actor.id,
        type: actor.type,
        display_name: actor.displayName,
      })),
      attachments: held.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        media_type: attachment.mediaType,
        size_bytes: attachment.sizeBytes,
        content_hash: attachment.contentHash,
        included: options.withAttachments,
      })),
    };

    return {
      manifest,
      copy: options.withAttachments
        ? held.map((attachment) => ({ id: attachment.id, contentHash: attachment.contentHash }))
        : [],
    };
  }
}

const FORMAT_VERSION = 1 as const;

/**
 * As many attachments as a workspace can have and still be exported whole.
 *
 * The list is read into memory to be written into the manifest, and a manifest
 * that silently stopped at the default page would describe a different export
 * from the one on disk.
 */
const ATTACHMENT_LIMIT = 100_000;
