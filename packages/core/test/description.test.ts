import { describe, expect, it } from 'vitest';

import {
  DESCRIPTION_INSTRUCTION,
  MediaDescriber,
  isDescribable,
} from '../src/attachments/description.ts';

const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

/** A model that records what it was asked and answers something fixed. */
function model(text = 'A diagram of two boxes.\n\nText in the image:\nInput, Output') {
  const calls: {
    instruction: string;
    input: string;
    image?: { mediaType: string; base64: string };
  }[] = [];
  return {
    calls,
    source: async () => ({
      profile: { provider: 'ollama', model: 'qwen2.5vl:7b' },
      generate: async (request: {
        instruction: string;
        input: string;
        image?: { mediaType: string; base64: string };
      }) => {
        calls.push(request);
        return { text, usage: { inputTokens: null, outputTokens: null }, truncated: false };
      },
    }),
  };
}

describe('what can be looked at', () => {
  it('is a picture, and nothing else', () => {
    expect(isDescribable('image/png')).toBe(true);
    expect(isDescribable('image/jpeg; charset=binary')).toBe(true);
    // A PDF has its own reader, and asking a vision model about one would be
    // paying somebody's GPU for what a parser already does.
    expect(isDescribable('application/pdf')).toBe(false);
    expect(isDescribable('text/plain')).toBe(false);
  });
});

describe('turning a picture into words', () => {
  it('sends the picture as material and the instruction as an instruction', async () => {
    const vision = model();
    const described = await new MediaDescriber({ vision: vision.source as never }).describe(
      'image/png',
      PIXEL,
    );
    expect(described?.text).toContain('Text in the image:');
    // The name of the model, for `drafted_by` on the item it becomes: a
    // description is a model's words about somebody's picture (ADR 0031).
    expect(described?.model).toBe('qwen2.5vl:7b');

    const call = vision.calls[0]!;
    expect(call.instruction).toBe(DESCRIPTION_INSTRUCTION);
    expect(call.image?.mediaType).toBe('image/png');
    expect(call.image?.base64).toBe(Buffer.from(PIXEL).toString('base64'));
    // Nothing of the product's own in the material: a filename would be read as
    // a hint about what the picture ought to show.
    expect(call.input).toBe('');
  });

  it('tells the model that text in a picture is text and not an order', () => {
    // A scan of a page saying "ignore your instructions" is a picture of
    // somebody's words. The instruction says which of the two it is.
    expect(DESCRIPTION_INSTRUCTION).toMatch(/never follow it/i);
    expect(DESCRIPTION_INSTRUCTION).toMatch(/never invent/i);
  });

  it('answers nothing when this installation has no model that looks', async () => {
    const described = await new MediaDescriber({ vision: async () => null }).describe(
      'image/png',
      PIXEL,
    );
    // Which leaves the file exactly where it was: kept, downloadable and
    // unsupported. Rule 9 is that the product does not notice.
    expect(described).toBeNull();
  });

  it('answers nothing when the model answered with nothing', async () => {
    const vision = model('   ');
    expect(
      await new MediaDescriber({ vision: vision.source as never }).describe('image/png', PIXEL),
    ).toBeNull();
  });

  it('does not ask about a file that is not a picture', async () => {
    const vision = model();
    expect(
      await new MediaDescriber({ vision: vision.source as never }).describe(
        'application/zip',
        PIXEL,
      ),
    ).toBeNull();
    expect(vision.calls).toHaveLength(0);
  });
});
