import {
  AttachmentId,
  type FrontmatterSource,
  type RevisionId,
  type WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';
import type { SourceRepository } from './repository.ts';

/**
 * The sources a revision rested on, written down.
 *
 * Shared by the two paths that can produce a revision, because they have to
 * agree: the ordinary write, and recovery rebuilding one from its commit. The
 * frontmatter carries the portable copy and PostgreSQL carries the queryable
 * one, and a revision recovered without these rows is one that cites a file in
 * its own text while the database says nothing rests on that file.
 *
 * Attached to the revision rather than to the item, because which sources were
 * cited is part of what the revision said — an older revision keeps its own
 * even after the item moves on.
 */
export async function recordSources(
  sources: SourceRepository,
  tx: Tx,
  workspaceId: WorkspaceId,
  revisionId: RevisionId,
  cited: readonly FrontmatterSource[],
  at: Date,
): Promise<void> {
  if (cited.length === 0) return;
  const ids = await sources.ensure(
    tx,
    workspaceId,
    cited.map((source) => ({
      sourceType: source.type,
      uri: source.uri ?? null,
      externalSystem: source.client ?? null,
      externalKey: source.external_key ?? null,
      // The one source type that names something this installation holds. It is
      // what makes "which items came out of this file" a question the database
      // can answer (ADR 0008).
      attachmentId:
        source.type === 'attachment' && AttachmentId.safeParse(source.external_key).success
          ? (source.external_key ?? null)
          : null,
      sourceModifiedAt: null,
      sourceContentHash: source.content_hash ?? null,
      confidence: null,
      metadata: source.session_id ? { session_id: source.session_id } : {},
    })),
    at,
  );
  await sources.attachToRevision(
    tx,
    ids.map((sourceReferenceId, index) => ({
      revisionId,
      sourceReferenceId,
      evidenceRole: cited[index]!.role,
      position: index,
    })),
  );
}
