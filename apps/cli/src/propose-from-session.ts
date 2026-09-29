import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import { readMarkdownFolder } from '@knoverge/core';
import { contentHash } from '@knoverge/git-store';

import type { Services } from './run.ts';

export interface ProposeFromSessionOptions {
  workspaceId: WorkspaceId;
  sessionId: string;
  /** The folder the session was taken from; a candidate's id is a path in it. */
  from: string;
  requestId: string;
}

export interface ProposeFromSessionResult {
  /** Proposals waiting for a reviewer. */
  proposed: number;
  /** Items written directly, when the agent's policy allows it (rule 14). */
  written: number;
  /** Candidates left alone, and why each was. */
  skipped: { path: string; why: string }[];
}

/** As many as one run proposes, so a folder of thousands is several runs. */
const BATCH = 500;

/**
 * Turning what a session found into proposals.
 *
 * Separate from the importer on purpose. An inventory is a question — this many
 * the workspace already has, this many look familiar, this many are new — and
 * proposing is what somebody decides after reading the answer (ADR 0036).
 *
 * Only `new_candidate`. A candidate the workspace recognised is one a person
 * should look at rather than one a command should act on: `likely_match` means
 * "read those items and decide", and deciding is not a thing to do in a loop.
 */
export async function proposeFromSession(
  services: Services,
  options: ProposeFromSessionOptions,
): Promise<ProposeFromSessionResult> {
  const session = await services.repositories.sync.findSession(
    options.workspaceId,
    options.sessionId,
  );
  if (!session) throw new Error(`no sync session ${options.sessionId} in this workspace`);
  const agent = await services.repositories.agents.findById(options.workspaceId, session.agentId);
  if (!agent) throw new Error(`the agent that opened this session no longer exists`);

  const actor: ActorContext = {
    workspaceId: options.workspaceId,
    actorId: agent.actorId,
    actorType: 'agent',
    agentId: agent.id,
    requestId: options.requestId,
    client: 'knoverge propose-from-session',
  };
  const standing = { trustTier: agent.trustTier };
  // Paths the taxonomy has. A candidate suggesting one it does not is proposed
  // without it rather than refused: the folder structure is a suggestion, and
  // creating categories is a separate decision with its own review.
  const tree = await services.repositories.categories.list(options.workspaceId, {});
  const known = new Set(tree.map((category) => category.path));

  const result: ProposeFromSessionResult = { proposed: 0, written: 0, skipped: [] };
  const candidates = await services.repositories.sync.listCandidates(session.id, { limit: BATCH });
  for (const candidate of candidates) {
    if (candidate.classification !== 'new_candidate') {
      result.skipped.push({ path: candidate.clientCandidateId, why: candidate.classification });
      continue;
    }
    const read = await fileFor(options.from, candidate.clientCandidateId);
    if (!read) {
      result.skipped.push({
        path: candidate.clientCandidateId,
        why: 'the file is no longer there',
      });
      continue;
    }
    // The file as it is now against the file as it was when the inventory was
    // taken. Proposing text the workspace never classified would make the
    // session a record of something that did not happen.
    if (candidate.sourceContentHash !== null && read.sourceHash !== candidate.sourceContentHash) {
      result.skipped.push({
        path: candidate.clientCandidateId,
        why: 'the file changed since the session was taken; run the importer again',
      });
      continue;
    }

    const outcome = await services.proposals.proposeCreate(actor, standing, {
      title: read.title,
      body: read.body,
      type: 'document',
      categories: candidate.proposedCategoryPaths.filter((path) => known.has(path)),
      // What this came from, so a second run recognises it by identity rather
      // than by text: the system names the tool and the key is the path.
      external: {
        source_system: session.sourceSystem,
        external_key: candidate.externalKey ?? candidate.clientCandidateId,
      },
      // So the run reads as a run: the proposals a session produced can be
      // found from the session, and the session from them.
      syncSessionId: session.id,
    });
    if (outcome.itemId) result.written += 1;
    else result.proposed += 1;
  }
  return result;
}

/** One candidate's file, parsed the way the importer parsed it. */
async function fileFor(
  root: string,
  path: string,
): Promise<{ title: string; body: string; sourceHash: string } | null> {
  let text: string;
  try {
    text = await readFile(join(root, path), 'utf8');
  } catch {
    return null;
  }
  // The same reader, so the title and the text are what the session was told
  // about rather than a second interpretation of the same file.
  const [candidate] = readMarkdownFolder({
    files: [{ path, text }],
    contentHash,
    sourceHash: (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`,
  });
  if (!candidate) return null;
  return { title: candidate.title, body: candidate.body, sourceHash: candidate.sourceHash };
}
