import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { AgentId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import { readJsonRecords } from '@knoverge/core';
import { contentHash } from '@knoverge/git-store';

import type { Services } from './run.ts';

export interface ImportJsonOptions {
  workspaceId: WorkspaceId;
  agentId: AgentId;
  file: string;
  sourceSystem: string;
  namespace: string;
  requestId: string;
}

export interface ImportJsonResult {
  sessionId: string;
  read: number;
  submitted: number;
  /** Records with no title or no body: not knowledge in any shape. */
  skipped: number;
  /** Candidates keyed by position because the record carried no id. */
  positional: number;
  classifications: Record<string, number>;
}

const BATCH = 200;

/**
 * A JSON export, offered to a workspace as a reconciliation session.
 *
 * The same three steps as a folder, because the shape is the shape (ADR 0036):
 * a session, an inventory, and an answer about each candidate. What differs is
 * the parser, which is the claim that ADR made and this is the second test of.
 *
 * This is the path for the exports nobody wrote a parser for. It is forgiving
 * about what fields are called and strict about what a record has to be: a
 * title and a body, or it is not knowledge.
 */
export async function importJson(
  services: Services,
  options: ImportJsonOptions,
): Promise<ImportJsonResult> {
  const agent = await services.repositories.agents.findById(options.workspaceId, options.agentId);
  if (!agent) throw new Error(`no agent with id ${options.agentId} in this workspace`);
  const actor: ActorContext = {
    workspaceId: options.workspaceId,
    actorId: agent.actorId,
    actorType: 'agent',
    agentId: agent.id,
    requestId: options.requestId,
    client: 'knoverge import-json',
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(options.file, 'utf8'));
  } catch (error) {
    throw new Error(`${options.file} is not JSON this can read: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const { candidates, skipped, positional } = readJsonRecords({
    parsed,
    contentHash,
    sourceHash: (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
  });

  const session = await services.sync.begin(
    actor,
    { source_system: options.sourceSystem, source_namespace: options.namespace },
    {
      taxonomyVersion: await services.repositories.taxonomyVersions.current(options.workspaceId),
      changeSequence: await services.repositories.events.latestSequence(options.workspaceId),
    },
  );

  const classifications: Record<string, number> = {};
  let submitted = 0;
  for (let at = 0; at < candidates.length; at += BATCH) {
    const { records } = await services.sync.submitInventory(
      actor,
      session.id,
      candidates.slice(at, at + BATCH).map((candidate) => ({
        client_candidate_id: candidate.key,
        external_key: candidate.key,
        title: candidate.title,
        type: 'document' as const,
        candidate_content_hash: candidate.contentHash,
        source_content_hash: candidate.sourceHash,
        proposed_category_paths: candidate.categoryPaths,
        ...(candidate.abstract === '' ? {} : { abstract: candidate.abstract }),
      })),
      async (itemIds: readonly string[]) => new Set(itemIds),
    );
    submitted += records.length;
    for (const record of records) {
      classifications[record.classification] = (classifications[record.classification] ?? 0) + 1;
    }
  }

  return {
    sessionId: session.id,
    read: candidates.length,
    submitted,
    skipped,
    positional,
    classifications,
  };
}
