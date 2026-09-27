import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

import type { WorkspaceId } from '@knoverge/contracts';
import {
  exportHeader,
  exportedEvent,
  verifyExport,
  type ExportHeader,
  type ExportedEvent,
} from '@knoverge/core';
import { Command } from 'commander';

import { emit, withServices } from '../run.ts';
import { ledgerKeyring } from '../services.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

/** How many events to read at a time. The file is written as they arrive. */
const PAGE = 500;

export function auditCommand(): Command {
  const cmd = new Command('audit').description('The event ledger, out of the installation');

  cmd
    .command('export')
    .description('Write a workspace’s ledger as JSON lines, with what it takes to verify it')
    .requiredOption('--workspace <slug|id>', 'the workspace to export')
    .requiredOption('--out <file>', 'where to write it')
    .option('--after <sequence>', 'export what follows this sequence, for an incremental run')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { workspace: string; out: string; after?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const workspace = await resolveWorkspace(services, opts.workspace);
        const after = Number(opts.after ?? 0);
        if (!Number.isInteger(after) || after < 0) throw new Error('--after must be a sequence');
        const keys = ledgerKeyring();

        // Read once and write as it goes: a workspace's ledger is the one thing
        // here with no bound on its size, and holding it all in memory to count it
        // first would make the export the reason an installation ran out.
        const file = createWriteStream(opts.out, { encoding: 'utf8' });
        const write = async (line: unknown) => {
          if (!file.write(`${JSON.stringify(line)}\n`)) await once(file, 'drain');
        };

        // The header goes first, so a reader knows what the file is before reading
        // it, which means the range has to be known before the events are read.
        // The ledger's own cursor answers that: it is gapless, so the count between
        // two sequences is arithmetic rather than a query.
        const latest = await services.repositories.events.latestSequence(workspace.id);
        const header = exportHeader(
          workspace.id as WorkspaceId,
          keys,
          { from: after + 1, to: latest, events: Math.max(0, latest - after) },
          new Date(),
        );
        await write(header);

        let written = 0;
        let cursor = after;
        for (;;) {
          const page = await services.repositories.events.listAfter(workspace.id, cursor, PAGE);
          if (page.length === 0) break;
          for (const event of page) {
            await write(exportedEvent(event));
            written += 1;
            cursor = event.sequence;
          }
        }
        file.end();
        await once(file, 'close');

        emit(opts.json ?? false, { path: opts.out, header, written }, () => [
          `exported ${written} event(s) to ${opts.out}`,
          `sequences ${header.from_sequence}–${header.to_sequence}`,
          `keys ${header.key_fingerprints.join(', ')}`,
        ]);
      });
    });

  cmd
    .command('verify')
    .description('Recompute the chain in an export, with no database involved')
    .requiredOption('--from <file>', 'an export written by knoverge audit export')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { from: string; json?: boolean }) => {
      // No services: the point of the format is that the file and the key are
      // enough. A verification that needed the database would prove nothing an
      // operator could hand to somebody else.
      const lines = (await readFile(opts.from, 'utf8')).split('\n').filter((l) => l.trim() !== '');
      const [first, ...rest] = lines;
      if (!first) throw new Error('that file is empty');
      const header = JSON.parse(first) as ExportHeader;
      if (header.knoverge_export !== 'audit') {
        throw new Error('the first line of an export says what it is; this one does not');
      }
      const events = rest.map((line) => JSON.parse(line) as ExportedEvent);
      const result = verifyExport(ledgerKeyring(), header, events);
      emit(opts.json ?? false, { header, ...result }, () => [
        [
          header.workspace_id,
          result.ok ? 'ok' : 'broken',
          String(result.count),
          ...(result.ok ? [] : [result.reason ?? '', `at ${result.brokenAt ?? 0}`]),
          ...(result.usedRetiredKey ? ['used a retired key'] : []),
        ]
          .filter((part) => part !== '')
          .join('\t'),
      ]);
      if (!result.ok) {
        console.error('the chain in this file does not hold together');
        process.exitCode = 1;
      }
    });

  return cmd;
}
