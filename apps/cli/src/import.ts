import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkspaceId } from '@knoverge/contracts';
import type { ImportManifest, ImportOutcome } from '@knoverge/core';

import type { Services } from './run.ts';

export interface ImportOptions {
  /** The export directory: a manifest, a bundle, and maybe attachments. */
  from: string;
  /** The slug to create it under, when the one it came from is taken. */
  slug?: string | undefined;
  requestId: string;
}

export interface ImportResult extends ImportOutcome {
  slug: string;
  categories: number;
  /** What arrived, and which rows name a file the export did not carry. */
  attachments: { copied: number; withoutBytes: string[] };
}

/**
 * Putting a workspace back from an export directory.
 *
 * The order is what makes it work: the workspace row first, because everything
 * else is scoped to it; then the repository, because it is where the knowledge
 * is; then the taxonomy, because a revision names its categories by path; then
 * the commits, oldest first. ADR 0035 records the decisions.
 */
export async function runImport(services: Services, options: ImportOptions): Promise<ImportResult> {
  const manifest = JSON.parse(
    await readFile(join(options.from, 'manifest.json'), 'utf8'),
  ) as ImportManifest;
  services.imports.check(manifest);

  const slug = options.slug ?? manifest.workspace.slug;
  const existing = await services.repositories.workspaces.findBySlug(slug);
  if (existing) {
    // Refused rather than merged: two workspaces may hold the same item id, and
    // deciding which revision wins is a reconciliation (ADR 0035).
    await services.imports.expectEmpty(existing.id);
  }
  const workspace =
    existing ??
    (await services.workspaces.create({
      slug,
      name: manifest.workspace.name,
      defaultLanguage: manifest.workspace.default_language,
      requestId: options.requestId,
    }));

  const system = await services.repositories.actors.findSystemActor(workspace.id);
  if (!system) throw new Error(`workspace ${slug} has no system actor`);
  const by = {
    workspaceId: workspace.id,
    actorId: system.id,
    actorType: 'system' as const,
    requestId: options.requestId,
    client: 'knoverge import',
  };

  await services.git.cloneFromBundle(workspace.id, join(options.from, 'repository.bundle'));
  const actorMap = await services.imports.recreateActors(workspace.id, manifest);
  const { categories } = await services.imports.restoreTaxonomy(workspace.id, by);
  // Bytes first, then rows, then the commits: an item made from a file names
  // the attachment in its frontmatter, and the source row that records it
  // points at the attachment row.
  const copied = await copyAttachments(services, workspace.id, options.from, manifest);
  const files = await services.imports.restoreAttachments(workspace.id, by, manifest, (hash) =>
    services.attachmentStore.has(workspace.id, hash),
  );
  const replayed = await services.imports.replay(workspace.id, by, actorMap);

  return {
    ...replayed,
    workspaceId: workspace.id,
    slug,
    actors: actorMap.size,
    categories,
    attachments: { copied, withoutBytes: files.withoutBytes },
  };
}

/**
 * The files the export carried, back into the store and into rows.
 *
 * By content hash, the way the store keeps them. A file the export listed but
 * did not carry is named rather than silently absent: an item whose source
 * points at nothing is worse than a report that says which.
 */
async function copyAttachments(
  services: Services,
  workspaceId: WorkspaceId,
  from: string,
  manifest: ImportManifest,
): Promise<number> {
  const carried = manifest.attachments.filter((attachment) => attachment.included);
  if (carried.length === 0) return 0;

  const directory = join(from, 'attachments');
  const present = new Set(await readdir(directory).catch(() => []));
  let copied = 0;
  for (const attachment of carried) {
    const name = attachment.content_hash.replace('sha256:', '');
    if (!present.has(name)) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(join(directory, name))) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    // Put by content, so the store decides the path and the hash it computes
    // has to match the one the manifest carried — a file that was corrupted in
    // transit lands under a different name and the row says it is missing.
    await services.attachmentStore.put(workspaceId, Buffer.concat(chunks));
    copied += 1;
  }
  return copied;
}
