import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

import type { AgentId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import { readMarkdownFolder } from '@knoverge/core';
import { contentHash } from '@knoverge/git-store';

import type { Services } from './run.ts';

export interface ImportFolderOptions {
  workspaceId: WorkspaceId;
  /** The agent this arrives as. An importer is an agent (ADR 0036). */
  agentId: AgentId;
  from: string;
  sourceSystem: string;
  namespace: string;
  requestId: string;
}

export interface ImportFolderResult {
  sessionId: string;
  read: number;
  submitted: number;
  /** How the workspace classified them, which is what a person reads next. */
  classifications: Record<string, number>;
}

/** As many files as one inventory may carry, which the contract caps at 200. */
const BATCH = 200;

/**
 * A folder of Markdown, offered to a workspace as a reconciliation session.
 *
 * It does not write knowledge. It says what the folder holds and lets the
 * workspace answer which of it is already known, which looks like something
 * known, and which is new — the same three steps an agent connecting for the
 * first time takes, because an importer is an agent (ADR 0036).
 */
export async function importFolder(
  services: Services,
  options: ImportFolderOptions,
): Promise<ImportFolderResult> {
  const agent = await services.repositories.agents.findById(options.workspaceId, options.agentId);
  if (!agent) throw new Error(`no agent with id ${options.agentId} in this workspace`);
  const actor: ActorContext = {
    workspaceId: options.workspaceId,
    actorId: agent.actorId,
    actorType: 'agent',
    agentId: agent.id,
    requestId: options.requestId,
    client: 'knoverge import-folder',
  };

  const files = await walk(options.from);
  const candidates = readMarkdownFolder({
    files,
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
    const batch = candidates.slice(at, at + BATCH);
    const { records } = await services.sync.submitInventory(
      actor,
      session.id,
      batch.map((candidate) => ({
        // The path inside the folder: a title changes and a body changes, and
        // this is what the person filing it chose (ADR 0036).
        client_candidate_id: candidate.path,
        external_key: candidate.path,
        title: candidate.title,
        // A note somebody wrote is source material until a person says what it
        // is: `document` is the type rule 15 gives that, and a reviewer can
        // change it when they accept it.
        type: 'document' as const,
        candidate_content_hash: candidate.contentHash,
        source_content_hash: candidate.sourceHash,
        proposed_category_paths: candidate.categoryPaths,
        ...(candidate.abstract === '' ? {} : { abstract: candidate.abstract }),
      })),
      // Everything, because this runs on the machine rather than for a caller
      // whose permissions decide what it may be told about.
      async (itemIds: readonly string[]) => new Set(itemIds),
    );
    submitted += records.length;
    for (const record of records) {
      classifications[record.classification] = (classifications[record.classification] ?? 0) + 1;
    }
  }

  return { sessionId: session.id, read: candidates.length, submitted, classifications };
}

/**
 * Every file under a directory, with its path relative to it.
 *
 * `.git`, `.obsidian` and the rest of the dot-directories are skipped: they are
 * a tool's own state, and a vault's `.obsidian/workspace.json` is not a note.
 */
async function walk(root: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(md|markdown)$/iu.test(entry.name)) continue;
      files.push({
        // Always forward slashes, whatever the machine uses: the path becomes
        // the key a second run is matched by, and a folder imported on Windows
        // and again on Linux is the same folder.
        path: relative(root, full).split(sep).join('/'),
        text: await readFile(full, 'utf8'),
      });
    }
  };
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
