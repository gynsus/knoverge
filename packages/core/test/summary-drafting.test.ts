import type { KnowledgeItemId, RevisionId, WorkspaceId } from '@knoverge/contracts';
import type { GenerationProvider, GenerationRequest } from '@knoverge/intelligence';
import { describe, expect, it, vi } from 'vitest';

import { DomainError, SummaryDrafter, type SourcePassage } from '../src/index.ts';
import type { KnowledgeItemRecord } from '../src/knowledge/repository.ts';

const workspaceId = 'ws_01M2XDRAFTDRAFTDRAFT0001' as WorkspaceId;
const A = 'kn_01M2XDRAFTDRAFTDRAFTAAAA' as KnowledgeItemId;
const B = 'kn_01M2XDRAFTDRAFTDRAFTBBBB' as KnowledgeItemId;
const GONE = 'kn_01M2XDRAFTDRAFTDRAFTZZZZ' as KnowledgeItemId;

function item(id: KnowledgeItemId, over: Partial<KnowledgeItemRecord> = {}): KnowledgeItemRecord {
  return {
    id,
    workspaceId,
    status: 'active',
    currentRevisionId: `rev_01M2XDRAFT${id.slice(-8)}00000000`.slice(0, 30) as RevisionId,
    ...over,
  } as KnowledgeItemRecord;
}

const rows = new Map<string, KnowledgeItemRecord>([
  [A, item(A)],
  [B, item(B)],
]);

/** A model that records what it was asked and answers whatever it was given. */
function writer(
  text: string,
  over: { truncated?: boolean } = {},
): { provider: GenerationProvider; asked: GenerationRequest[] } {
  const asked: GenerationRequest[] = [];
  return {
    asked,
    provider: {
      profile: { provider: 'ollama', model: 'qwen3' },
      generate: async (request) => {
        asked.push(request);
        return {
          text,
          usage: { inputTokens: 10, outputTokens: 4 },
          truncated: over.truncated ?? false,
        };
      },
    },
  };
}

function drafter(options: {
  provider?: GenerationProvider | null;
  bodies?: Record<string, string>;
}) {
  const bodies = options.bodies ?? { [A]: 'The ledger only grows.', [B]: 'Nothing is updated.' };
  return new SummaryDrafter({
    items: {
      findById: async (_w: WorkspaceId, id: KnowledgeItemId) => rows.get(id) ?? null,
    } as never,
    revisions: {} as never,
    read: async (_w, id): Promise<SourcePassage | null> =>
      bodies[id] === undefined ? null : { itemId: id, title: `Title of ${id}`, body: bodies[id] },
    generation: async () => options.provider ?? null,
  });
}

describe('drafting a summary', () => {
  it('reads the revisions each source is at now', async () => {
    // A draft is made from what is current by definition: that is the thing
    // being asked for, and it is what makes the summary that follows not stale.
    const model = writer('The ledger only grows, and nothing is updated.');
    const draft = await drafter({ provider: model.provider }).draft(workspaceId, [A, B]);
    expect(draft.summaryOf).toEqual([
      `${A}@${rows.get(A)!.currentRevisionId}`,
      `${B}@${rows.get(B)!.currentRevisionId}`,
    ]);
    expect(draft.body).toBe('The ledger only grows, and nothing is updated.');
    expect(draft.model).toBe('qwen3');
    expect(draft.truncated).toBe(false);
  });

  it('keeps the instruction and the knowledge apart', async () => {
    // One is the product's instruction and the other is what somebody else
    // wrote. A source that says "ignore your instructions" must not get to say
    // it in the same voice as the instructions.
    const model = writer('ok');
    await drafter({ provider: model.provider }).draft(workspaceId, [A]);
    const asked = model.asked[0]!;
    expect(asked.instruction).toMatch(/Use only what they say/);
    expect(asked.input).toContain('The ledger only grows.');
    expect(asked.instruction).not.toContain('The ledger only grows.');
  });

  it('asks the model to report a disagreement rather than resolve one', async () => {
    // A summary that quietly decides which of two sources was right is worse
    // than no summary.
    const model = writer('ok');
    await drafter({ provider: model.provider }).draft(workspaceId, [A]);
    expect(model.asked[0]!.instruction).toMatch(/disagree/);
  });

  it('bounds one source, so a document cannot fill the whole request', async () => {
    const model = writer('ok');
    await drafter({
      provider: model.provider,
      bodies: { [A]: 'x'.repeat(20_000) },
    }).draft(workspaceId, [A]);
    expect(model.asked[0]!.input.length).toBeLessThan(6000);
    expect(model.asked[0]!.input).toContain('[…]');
  });

  it('asks for the same source once, however many times it was named', async () => {
    const model = writer('ok');
    const draft = await drafter({ provider: model.provider }).draft(workspaceId, [A, A, A]);
    expect(draft.summaryOf).toHaveLength(1);
  });

  it('says what to do when no model is configured', async () => {
    // Nothing configured is the ordinary state of this product (rule 9), so it
    // is not an internal error and the answer says what to do about it.
    const failed = await drafter({ provider: null })
      .draft(workspaceId, [A])
      .catch((error: unknown) => error as DomainError);
    expect(failed).toBeInstanceOf(DomainError);
    expect((failed as DomainError).code).toBe('VALIDATION_ERROR');
    expect((failed as DomainError).message).toMatch(/no model is configured/);
  });

  it('refuses a summary of nothing, and a summary of too much', async () => {
    const model = writer('ok');
    const made = drafter({ provider: model.provider });
    await expect(made.draft(workspaceId, [])).rejects.toBeInstanceOf(DomainError);
    await expect(
      made.draft(
        workspaceId,
        Array.from(
          { length: 30 },
          (_, i) => `kn_01M2XDRAFT${String(i).padStart(14, '0')}` as KnowledgeItemId,
        ),
      ),
    ).rejects.toThrow(/at most/);
    // Neither reached the model, which is the point of checking first.
    expect(model.asked).toHaveLength(0);
  });

  it('refuses a source the workspace does not have', async () => {
    const model = writer('ok');
    await expect(drafter({ provider: model.provider }).draft(workspaceId, [GONE])).rejects.toThrow(
      /no knowledge item/,
    );
  });

  it('refuses a source whose file the repository does not hold', async () => {
    // The database says the item exists and the repository does not have it.
    // Drafting from an empty body would produce a summary of nothing at all.
    const model = writer('ok');
    await expect(
      drafter({ provider: model.provider, bodies: {} }).draft(workspaceId, [A]),
    ).rejects.toThrow(/does not contain the file/);
  });

  it('refuses an answer with nothing in it', async () => {
    const model = writer('   ');
    await expect(drafter({ provider: model.provider }).draft(workspaceId, [A])).rejects.toThrow(
      /returned nothing/,
    );
  });

  it('passes on that the model ran out of room', async () => {
    // A summary cut off mid-sentence is one nobody should save, and the text
    // alone does not say which happened.
    const model = writer('Half a sen', { truncated: true });
    expect((await drafter({ provider: model.provider }).draft(workspaceId, [A])).truncated).toBe(
      true,
    );
  });

  it('never writes anything', async () => {
    // It drafts, and a person saves it through the ordinary write — which is
    // where provenance, review and Git already live.
    const model = writer('ok');
    const insert = vi.fn();
    const made = new SummaryDrafter({
      items: {
        findById: async (_w: WorkspaceId, id: KnowledgeItemId) => rows.get(id) ?? null,
        insert,
        update: insert,
      } as never,
      revisions: { insert } as never,
      read: async (_w, id) => ({ itemId: id, title: 'A title', body: 'A body.' }),
      generation: async () => model.provider,
    });
    await made.draft(workspaceId, [A]);
    expect(insert).not.toHaveBeenCalled();
  });
});
