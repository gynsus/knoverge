import type { WorkspaceId } from '@knoverge/contracts';

import { fingerprint, genesisHash, keysOf, type LedgerKeyring } from './hash.ts';
import { ChainWalker, type VerifyResult } from './ledger.ts';
import type { EventRecord } from './types.ts';

/**
 * The first line of an export: what this is, and what it takes to check it.
 *
 * An export nobody can verify is a list of claims about a workspace. This carries
 * the fingerprint of the key the events were signed with, so an auditor knows
 * which key to bring, and the genesis hash, so the chain can be checked from the
 * file alone — the point of the format is that the database is not needed
 * afterwards.
 */
export interface ExportHeader {
  knoverge_export: 'audit';
  version: 1;
  workspace_id: WorkspaceId;
  /** The sequence range in the file, inclusive. Zero and zero for an empty one. */
  from_sequence: number;
  to_sequence: number;
  events: number;
  exported_at: string;
  /** Fingerprints of the keys that could verify it, the signing one first. */
  key_fingerprints: string[];
  /** The chain's first `prev_event_hash`, for a file that starts at sequence 1. */
  genesis: string;
}

/** One line per event, as written and nothing added. */
export interface ExportedEvent {
  id: string;
  sequence: number;
  hash_version: number;
  event_type: string;
  object_type: string;
  object_id: string;
  actor_id: string;
  agent_id: string | null;
  request_id: string;
  session_id: string | null;
  client: string | null;
  provider: string | null;
  model: string | null;
  before_revision_id: string | null;
  before_content_hash: string | null;
  after_revision_id: string | null;
  after_content_hash: string | null;
  proposal_id: string | null;
  source_reference_id: string | null;
  category_ids: string[];
  metadata: Record<string, unknown>;
  prev_event_hash: string;
  event_hash: string;
  created_at: string;
}

/**
 * An event as the export writes it.
 *
 * Every field the hash covers, under the names the hasher uses, plus the two chain
 * hashes and the hash version. Not the same shape `events_list` serves: that one
 * resolves category ids to paths for a reader, and a path is a name that can change
 * while an id cannot. An export is for checking, so it carries what was signed.
 */
export function exportedEvent(event: EventRecord): ExportedEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    hash_version: event.hashVersion,
    event_type: event.eventType,
    object_type: event.objectType,
    object_id: event.objectId,
    actor_id: event.actorId,
    agent_id: event.agentId,
    request_id: event.requestId,
    session_id: event.sessionId,
    client: event.client,
    provider: event.provider,
    model: event.model,
    before_revision_id: event.beforeRevisionId,
    before_content_hash: event.beforeContentHash,
    after_revision_id: event.afterRevisionId,
    after_content_hash: event.afterContentHash,
    proposal_id: event.proposalId,
    source_reference_id: event.sourceReferenceId,
    category_ids: [...event.categoryIds],
    metadata: event.metadata,
    prev_event_hash: event.prevEventHash,
    event_hash: event.eventHash,
    created_at: event.createdAt.toISOString(),
  };
}

/** The header for a run, given what it is about to write. */
export function exportHeader(
  workspaceId: WorkspaceId,
  keys: LedgerKeyring,
  range: { from: number; to: number; events: number },
  now: Date,
): ExportHeader {
  return {
    knoverge_export: 'audit',
    version: 1,
    workspace_id: workspaceId,
    from_sequence: range.from,
    to_sequence: range.to,
    events: range.events,
    exported_at: now.toISOString(),
    key_fingerprints: keysOf(keys).map(fingerprint),
    genesis: genesisHash(keys.signing),
  };
}

/**
 * Turns a line back into what the hasher hashes.
 *
 * The workspace id comes from the header rather than from the line: it is in what
 * was signed and not in what is written per event, because repeating it on every
 * line of a file that names it once at the top is noise.
 */
export function rehydrate(
  line: ExportedEvent,
  workspaceId: WorkspaceId,
): Omit<EventRecord, 'eventHash'> {
  return {
    id: line.id as EventRecord['id'],
    hashVersion: line.hash_version,
    workspaceId,
    sequence: line.sequence,
    eventType: line.event_type as EventRecord['eventType'],
    actorId: line.actor_id,
    agentId: line.agent_id,
    requestId: line.request_id,
    sessionId: line.session_id,
    client: line.client,
    provider: line.provider,
    model: line.model,
    objectType: line.object_type as EventRecord['objectType'],
    objectId: line.object_id,
    beforeRevisionId: line.before_revision_id,
    beforeContentHash: line.before_content_hash,
    afterRevisionId: line.after_revision_id,
    afterContentHash: line.after_content_hash,
    proposalId: line.proposal_id,
    sourceReferenceId: line.source_reference_id,
    categoryIds: [...line.category_ids],
    metadata: line.metadata,
    prevEventHash: line.prev_event_hash,
    createdAt: new Date(line.created_at),
  };
}

/**
 * Checks an export against a keyring, with the database nowhere in it.
 *
 * This is what makes the file worth having: an auditor with the export and the key
 * can recompute every hash and see that the chain holds, without the installation
 * that produced it and without trusting whoever handed it over. A file that starts
 * part way along the ledger is checked from its first line onwards — the links
 * inside it still have to hold, and the header says where it began.
 */
export function verifyExport(
  keys: LedgerKeyring,
  header: ExportHeader,
  lines: readonly ExportedEvent[],
): VerifyResult {
  const walker = new ChainWalker(keys);
  const first = lines[0];
  if (first && first.sequence !== 1) {
    // A partial export: nothing before the first line is here to check, so the
    // walk starts where the file does and the previous hash it names is taken as
    // given. Said rather than assumed, because "verified" means something
    // narrower for a slice than for a whole ledger.
    walker.expectSequence(first.sequence, first.prev_event_hash);
  }
  for (const line of lines) {
    const failed = walker.next(rehydrate(line, header.workspace_id), line.event_hash);
    if (failed) return failed;
  }
  return walker.done();
}
