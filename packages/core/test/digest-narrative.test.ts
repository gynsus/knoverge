import type { GenerationProvider, GenerationRequest } from '@knoverge/intelligence';
import { describe, expect, it } from 'vitest';

import { DigestNarrator, type DigestFacts } from '../src/index.ts';

function writer(text: string): { provider: GenerationProvider; asked: GenerationRequest[] } {
  const asked: GenerationRequest[] = [];
  return {
    asked,
    provider: {
      profile: { provider: 'ollama', model: 'qwen3' },
      generate: async (request) => {
        asked.push(request);
        return { text, usage: { inputTokens: 20, outputTokens: 30 }, truncated: false };
      },
    },
  };
}

const busy: DigestFacts = {
  since: '2026-09-25T00:00:00.000Z',
  until: '2026-09-26T00:00:00.000Z',
  counts: [
    { eventType: 'knowledge.updated', count: 7 },
    { eventType: 'knowledge.created', count: 2 },
  ],
  changed: [
    { title: 'Retention is ninety days', changeKinds: ['updated'] },
    { title: null, changeKinds: ['created'] },
  ],
  resolvedProposals: [{ status: 'approved' }, { status: 'approved' }, { status: 'rejected' }],
};

describe('describing a period', () => {
  it('reads the tally out, and says which model did', async () => {
    const model = writer('Seven records changed and two were added.');
    const narrative = await new DigestNarrator(async () => model.provider).describe(busy);
    expect(narrative).toEqual({
      text: 'Seven records changed and two were added.',
      model: 'qwen3',
    });
  });

  it('sends the tally as material and the instruction as instruction', async () => {
    const model = writer('ok');
    await new DigestNarrator(async () => model.provider).describe(busy);
    const asked = model.asked[0]!;
    expect(asked.input).toContain('knowledge.updated: 7');
    expect(asked.input).toContain('Retention is ninety days');
    expect(asked.instruction).not.toContain('Retention is ninety days');
  });

  it('counts the proposals by how they were decided', async () => {
    const model = writer('ok');
    await new DigestNarrator(async () => model.provider).describe(busy);
    expect(model.asked[0]!.input).toContain('approved: 2');
    expect(model.asked[0]!.input).toContain('rejected: 1');
  });

  it('tells the model not to guess why anything happened', async () => {
    // A digest that invents a reason is worse than a list.
    const model = writer('ok');
    await new DigestNarrator(async () => model.provider).describe(busy);
    expect(model.asked[0]!.instruction).toMatch(/not guess why/);
  });

  it('names a bounded number of records and says how many it left out', async () => {
    const model = writer('ok');
    await new DigestNarrator(async () => model.provider).describe({
      ...busy,
      changed: Array.from({ length: 120 }, (_, i) => ({
        title: `Record ${i}`,
        changeKinds: ['updated'],
      })),
    });
    const input = model.asked[0]!.input;
    expect(input).toContain('Record 0');
    expect(input).not.toContain('Record 119');
    expect(input).toMatch(/and \d+ more/);
  });

  it('is null when nothing is configured to write it', async () => {
    // Rule 9: the counts are the digest, and an absent optional feature does
    // not make a missing one.
    expect(await new DigestNarrator(async () => null).describe(busy)).toBeNull();
  });

  it('does not ask a model to describe a period nothing happened in', async () => {
    const model = writer('Nothing happened, which is itself worth saying.');
    const quiet = await new DigestNarrator(async () => model.provider).describe({
      ...busy,
      counts: [],
      changed: [],
      resolvedProposals: [],
    });
    expect(quiet).toBeNull();
    expect(model.asked).toHaveLength(0);
  });

  it('is null when the model said nothing, because that is what null means', async () => {
    const model = writer('   ');
    expect(await new DigestNarrator(async () => model.provider).describe(busy)).toBeNull();
  });
});
