import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { WorkspaceId } from '@knoverge/contracts';
import type { ExportManifest } from '@knoverge/core';

import type { Services } from './run.ts';

export interface ExportOptions {
  workspaceId: WorkspaceId;
  /** Where the export directory goes. */
  into: string;
  /** Whether the attachment bytes are carried, or only listed. */
  withAttachments: boolean;
  now?: Date;
}

export interface ExportResult {
  path: string;
  manifest: ExportManifest;
  /** The files copied, and the ones a row claims that the store does not hold. */
  attachments: { copied: number; missing: string[] };
}

/** UTC to the second, which sorts in the order the exports were taken. */
function stamp(now: Date): string {
  return `${now.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
}

/**
 * One workspace, packed to be carried somewhere else.
 *
 * A bundle of the repository, a manifest, and the attachments when asked for.
 * ADR 0034 says why that is the whole of it, and why this is not `knoverge
 * backup` under another name.
 *
 * The workspace write lock is held for the read, so the bundle and the manifest
 * describe one moment: an export taken while a write was landing would name a
 * ledger sequence the bundle does not reach.
 */
export async function takeExport(
  services: Services,
  options: ExportOptions,
): Promise<ExportResult> {
  const at = stamp(options.now ?? new Date());
  const target = join(options.into, `${at}-${options.workspaceId}`);
  // Built beside the final name and moved into place at the end, so a run that
  // dies half way leaves nothing an import could mistake for a whole export.
  const staging = `${target}.partial`;
  await mkdir(staging, { recursive: true });

  try {
    const { manifest, copy } = await services.uow.withWorkspaceLock(
      options.workspaceId,
      async () => {
        const described = await services.exports.describe(options.workspaceId, {
          takenBy: 'knoverge export',
          withAttachments: options.withAttachments,
        });
        await services.git.bundle(options.workspaceId, join(staging, 'repository.bundle'));
        return described;
      },
    );

    const missing: string[] = [];
    let copied = 0;
    if (copy.length > 0) {
      const directory = join(staging, 'attachments');
      await mkdir(directory, { recursive: true });
      for (const attachment of copy) {
        // Under the hash, the way the store keeps them: an import puts the bytes
        // back by content, and a filename is what an uploader called it rather
        // than where it lives (ADR 0008).
        if (!(await services.attachmentStore.has(options.workspaceId, attachment.contentHash))) {
          missing.push(attachment.id);
          continue;
        }
        await pipeline(
          services.attachmentStore.read(options.workspaceId, attachment.contentHash),
          createWriteStream(join(directory, attachment.contentHash.replace('sha256:', ''))),
        );
        copied += 1;
      }
    }

    // Written last, and with what actually happened to the files: a manifest
    // claiming bytes that are not there is worse than one that names the gap.
    await writeFile(
      join(staging, 'manifest.json'),
      `${JSON.stringify(withMissing(manifest, missing), null, 2)}\n`,
      'utf8',
    );
    await writeFile(join(staging, 'README.md'), readme(manifest), 'utf8');
    await rename(staging, target);
    return { path: target, manifest, attachments: { copied, missing } };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The manifest, with `included` telling the truth about each file. */
function withMissing(manifest: ExportManifest, missing: readonly string[]): ExportManifest {
  if (missing.length === 0) return manifest;
  const gone = new Set(missing);
  return {
    ...manifest,
    attachments: manifest.attachments.map((attachment) =>
      gone.has(attachment.id) ? { ...attachment, included: false } : attachment,
    ),
  };
}

/**
 * What somebody who opens the directory reads first.
 *
 * An export is meant to be readable without this product, and "readable" starts
 * with knowing that the bundle is a git repository rather than an archive nobody
 * recognises.
 */
function readme(manifest: ExportManifest): string {
  return [
    `# ${manifest.workspace.name}`,
    '',
    `A Knoverge workspace, exported ${manifest.taken_at}.`,
    '',
    '## What is here',
    '',
    '- `repository.bundle` — the knowledge itself: Markdown with YAML frontmatter,',
    '  the category tree in `taxonomy.yaml`, and every revision as a commit. Open it',
    '  with git, and nothing else is required:',
    '',
    '  ```bash',
    '  git clone repository.bundle workspace',
    '  ```',
    '',
    '- `manifest.json` — what the files cannot say: the workspace it came from, who',
    '  the commit trailers name, and every attachment it holds.',
    manifest.attachments.some((a) => a.included)
      ? '- `attachments/` — the uploaded files, each named by the hash of its contents.'
      : '- No attachments were included. `manifest.json` lists what the workspace holds.',
    '',
    '## What is not here',
    '',
    'Agents, credentials, permissions, proposals and the event ledger stay with the',
    'installation that made them: who may write is a statement about an installation,',
    'and the ledger is keyed with a key that never leaves it. See ADR 0034.',
    '',
  ].join('\n');
}
