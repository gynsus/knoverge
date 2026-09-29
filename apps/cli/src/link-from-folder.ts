import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { AgentId, KnowledgeItemId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import { readMarkdownFolder } from '@knoverge/core';
import { contentHash } from '@knoverge/git-store';

import type { Services } from './run.ts';

export interface LinkFromFolderOptions {
  workspaceId: WorkspaceId;
  agentId: AgentId;
  from: string;
  /** The system the notes were imported under, which is how they are found. */
  sourceSystem: string;
  requestId: string;
}

export interface LinkFromFolderResult {
  /** Notes that are items here and were looked at. */
  examined: number;
  /** Updates proposed, and ones written directly where policy allows it. */
  proposed: number;
  written: number;
  /** Links that went nowhere, grouped by why. */
  unresolved: { from: string; target: string; why: string }[];
}

/**
 * Turning `[[wikilinks]]` into relations, once both ends are items.
 *
 * A separate run from the importing, because a relation needs both ends to
 * exist: when a note is proposed, the note it links to may still be in the queue
 * or may not have been proposed at all. So this is what somebody runs after the
 * proposals a folder produced have been accepted.
 *
 * Every link becomes `relates_to`. A wiki link says these two notes are
 * connected and nothing more precise than that; reading `supersedes` or
 * `contradicts` into one would be inventing a claim the person never made.
 */
export async function linkFromFolder(
  services: Services,
  options: LinkFromFolderOptions,
): Promise<LinkFromFolderResult> {
  const agent = await services.repositories.agents.findById(options.workspaceId, options.agentId);
  if (!agent) throw new Error(`no agent with id ${options.agentId} in this workspace`);
  const actor: ActorContext = {
    workspaceId: options.workspaceId,
    actorId: agent.actorId,
    actorType: 'agent',
    agentId: agent.id,
    requestId: options.requestId,
    client: 'knoverge link-from-folder',
  };
  const standing = { trustTier: agent.trustTier };

  const files = await walk(options.from);
  const candidates = readMarkdownFolder({
    files,
    contentHash,
    sourceHash: (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
  });

  // How a wiki link is resolved: by the note's own name, which is what people
  // type, and by its path, which is what they type when two notes share a name.
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  for (const candidate of candidates) {
    const name = candidate.path.slice(candidate.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/u, '');
    byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), candidate.path]);
    byPath.set(candidate.path.replace(/\.[^.]+$/u, '').toLowerCase(), candidate.path);
  }

  const result: LinkFromFolderResult = { examined: 0, proposed: 0, written: 0, unresolved: [] };
  for (const candidate of candidates) {
    if (candidate.links.length === 0) continue;
    const item = await services.repositories.knowledge.findByExternal(
      options.workspaceId,
      options.sourceSystem,
      candidate.path,
    );
    // A note nobody accepted yet is not an item, and there is nothing to attach
    // a relation to. Saying so is more useful than counting it as a failure.
    if (!item) {
      for (const target of candidate.links) {
        result.unresolved.push({
          from: candidate.path,
          target,
          why: 'this note is not an item yet',
        });
      }
      continue;
    }
    result.examined += 1;

    const targets: KnowledgeItemId[] = [];
    for (const link of candidate.links) {
      const wanted = link.toLowerCase();
      const path = byPath.get(wanted) ?? only(byName.get(wanted));
      if (!path) {
        result.unresolved.push({
          from: candidate.path,
          target: link,
          why: byName.get(wanted) ? 'several notes have that name' : 'no note has that name',
        });
        continue;
      }
      const to = await services.repositories.knowledge.findByExternal(
        options.workspaceId,
        options.sourceSystem,
        path,
      );
      if (!to) {
        result.unresolved.push({
          from: candidate.path,
          target: link,
          why: 'the note it points at is not an item yet',
        });
        continue;
      }
      if (to.id !== item.id) targets.push(to.id);
    }
    if (targets.length === 0) continue;

    const current = await services.repositories.revisions.findById(
      options.workspaceId,
      item.currentRevisionId as never,
    );
    if (!current) continue;
    // Every relation the item should have, because the update replaces the
    // whole list: the ones it already had, and the ones the links resolved to.
    const already = current.frontmatter.relations ?? [];
    const wanted = [
      ...already,
      ...targets
        .filter((id) => !already.some((relation) => relation.target === id))
        .map((id) => ({ type: 'relates_to' as const, target: id })),
    ];
    if (wanted.length === already.length) continue;

    const outcome = await services.proposals.proposeUpdate(actor, standing, {
      itemId: item.id,
      baseRevisionId: current.id,
      baseContentHash: current.contentHash,
      relations: wanted,
      reason: 'links between imported notes',
    });
    if (outcome.itemId) result.written += 1;
    else result.proposed += 1;
  }
  return result;
}

/** The one path, when a name belongs to exactly one note. */
function only(paths: string[] | undefined): string | undefined {
  return paths?.length === 1 ? paths[0] : undefined;
}

/** Every Markdown file under a directory, with its path relative to it. */
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
      if (!entry.isFile() || !/\.(md|markdown)$/iu.test(entry.name)) continue;
      files.push({
        path: relative(root, full).split(sep).join('/'),
        text: await readFile(full, 'utf8'),
      });
    }
  };
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
