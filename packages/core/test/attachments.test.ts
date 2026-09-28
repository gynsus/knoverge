import { describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/actor-context.ts';
import { AttachmentService, type AttachmentStore } from '../src/attachments/service.ts';
import type { AttachmentRecord, AttachmentRepository } from '../src/attachments/repository.ts';
import { DomainError } from '../src/errors.ts';

/**
 * What the domain refuses before anything is written.
 *
 * The HTTP route refuses most of these first — the multipart parser stops at the
 * installation's limit, and it takes a directory off a filename before the domain
 * sees one. These are the same rules for a caller that is not that route, which
 * is what the MCP upload will be, and a rule only one transport enforces is a rule
 * the other transport does not have.
 */
const actor: ActorContext = {
  workspaceId: 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as never,
  actorId: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as never,
  actorType: 'human',
  requestId: 'req-1',
};

/** Neither is reached by anything below: every case throws before a write. */
const store = {
  put: () => {
    throw new Error('nothing should be written');
  },
  has: async () => false,
  read: () => {
    throw new Error('nothing should be read');
  },
} as unknown as AttachmentStore;

const attachments: AttachmentRepository = {
  insert: async () => {
    throw new Error('no row should be inserted');
  },
  findById: async () => null,
  findByHash: async () => null,
  list: async () => [] as AttachmentRecord[],
  claimUnread: async () => [] as AttachmentRecord[],
  setExtraction: async () => {
    throw new Error('nothing should be settled');
  },
};

function service(maxBytes = 1024) {
  return new AttachmentService({
    uow: {
      run: () => {
        throw new Error('no transaction should be opened');
      },
    } as never,
    attachments,
    store,
    ledger: {} as never,
    maxBytes,
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('a file the domain will not take', () => {
  it('is one larger than this installation accepts', async () => {
    await expect(
      service(16).upload(actor, {
        filename: 'big.txt',
        mediaType: 'text/plain',
        bytes: bytes('This is more than sixteen bytes.\n'),
      }),
    ).rejects.toThrow(DomainError);
  });

  it('is an empty one, which says nothing and would still take a row', async () => {
    await expect(
      service().upload(actor, {
        filename: 'empty.txt',
        mediaType: 'text/plain',
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow(/empty/u);
  });

  it('is one whose name is a path', async () => {
    await expect(
      service().upload(actor, {
        filename: '../../etc/passwd',
        mediaType: 'text/plain',
        bytes: bytes('root:x:0:0\n'),
      }),
    ).rejects.toThrow(/filename/u);
  });

  it('is one with no name at all', async () => {
    await expect(
      service().upload(actor, {
        filename: '   ',
        mediaType: 'text/plain',
        bytes: bytes('Unnamed.\n'),
      }),
    ).rejects.toThrow(/filename/u);
  });

  it('is one whose name carries a line break into a header', async () => {
    // What a file is called goes into `content-disposition` on the way out. A
    // name with a newline in it is a second header the uploader wrote.
    await expect(
      service().upload(actor, {
        filename: 'ok.txt\r\nX-Injected: 1',
        mediaType: 'text/plain',
        bytes: bytes('Header injection.\n'),
      }),
    ).rejects.toThrow(/filename/u);
  });
});
