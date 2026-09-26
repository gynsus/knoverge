import { describe, expect, it, vi } from 'vitest';

import { GenerationError, createHttpGenerationProvider } from '../src/index.ts';

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const openai = (text: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop', ...extra }],
  usage: { prompt_tokens: 40, completion_tokens: 7 },
});

const ollama = (text: string, extra: Record<string, unknown> = {}) => ({
  message: { role: 'assistant', content: text },
  done_reason: 'stop',
  prompt_eval_count: 40,
  eval_count: 7,
  ...extra,
});

const ask = { instruction: 'Summarise what these say.', input: 'The ledger is append-only.' };

describe('a generation provider over HTTP', () => {
  it('reads the OpenAI shape, and sends the key as a bearer', async () => {
    const fetch = vi.fn(async () => answer(openai('  The ledger only grows.  ')));
    const provider = createHttpGenerationProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:8080/',
      model: 'qwen3',
      apiKey: 'secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const result = await provider.generate(ask);
    expect(result.text).toBe('The ledger only grows.');
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 7 });
    expect(result.truncated).toBe(false);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // The trailing slash of the base does not become a double slash.
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret');
  });

  it('reads the Ollama shape, at its own path and with streaming off', async () => {
    const fetch = vi.fn(async () => answer(ollama('The ledger only grows.')));
    const provider = createHttpGenerationProvider({
      provider: 'ollama',
      baseUrl: 'http://192.168.1.7:11434',
      model: 'qwen3',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect((await provider.generate(ask)).text).toBe('The ledger only grows.');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://192.168.1.7:11434/api/chat');
    // Streaming would arrive as many JSON objects, and this reads one.
    expect(JSON.parse(init.body as string).stream).toBe(false);
  });

  it('keeps the instruction and the material apart on the wire', async () => {
    // One is the product's instruction and the other is knowledge somebody
    // else wrote. Concatenating them is how material that says "ignore your
    // instructions" gets to say it in the same voice as the instructions.
    const fetch = vi.fn(async () => answer(openai('ok')));
    const provider = createHttpGenerationProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:8080',
      model: 'qwen3',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await provider.generate(ask);
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.messages).toEqual([
      { role: 'system', content: 'Summarise what these say.' },
      { role: 'user', content: 'The ledger is append-only.' },
    ]);
  });

  it('says when the model stopped because it ran out of room', async () => {
    // A summary cut off mid-sentence is one nobody should store, and the text
    // alone does not say which happened.
    for (const [provider, body] of [
      ['openai_compatible', openai('Half a sen', { finish_reason: 'length' })],
      ['ollama', ollama('Half a sen', { done_reason: 'length' })],
    ] as const) {
      const made = createHttpGenerationProvider({
        provider,
        baseUrl: 'http://localhost:8080',
        model: 'qwen3',
        fetch: vi.fn(async () => answer(body)) as unknown as typeof globalThis.fetch,
      });
      expect((await made.generate(ask)).truncated).toBe(true);
    }
  });

  it('carries the ceiling each shape spells differently', async () => {
    const openaiFetch = vi.fn(async () => answer(openai('ok')));
    await createHttpGenerationProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:8080',
      model: 'qwen3',
      fetch: openaiFetch as unknown as typeof globalThis.fetch,
    }).generate({ ...ask, maxOutputTokens: 64, temperature: 0 });
    const first = JSON.parse(
      (openaiFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(first.max_tokens).toBe(64);
    expect(first.temperature).toBe(0);

    const ollamaFetch = vi.fn(async () => answer(ollama('ok')));
    await createHttpGenerationProvider({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3',
      fetch: ollamaFetch as unknown as typeof globalThis.fetch,
    }).generate({ ...ask, maxOutputTokens: 64, temperature: 0 });
    const second = JSON.parse(
      (ollamaFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(second.options).toEqual({ temperature: 0, num_predict: 64 });
  });

  it('defaults to a low temperature, because this is not creative writing', async () => {
    const fetch = vi.fn(async () => answer(openai('ok')));
    await createHttpGenerationProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:8080',
      model: 'qwen3',
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).generate(ask);
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.temperature).toBeLessThanOrEqual(0.3);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('reports the status and never the body', async () => {
    // The body may quote the prompt, and the prompt is knowledge.
    const provider = createHttpGenerationProvider({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3',
      fetch: vi.fn(async () =>
        answer({ error: 'model "qwen3" not found, pull it first' }, 404),
      ) as unknown as typeof globalThis.fetch,
    });
    await expect(provider.generate(ask)).rejects.toThrow(/answered 404/);
    await expect(provider.generate(ask)).rejects.not.toThrow(/pull it first/);
  });

  it('refuses an answer that is not in the shape it asked for', async () => {
    for (const [provider, body] of [
      ['openai_compatible', { choices: [] }],
      ['openai_compatible', { choices: [{ message: {} }] }],
      ['ollama', { done_reason: 'stop' }],
      ['ollama', 'not an object'],
    ] as const) {
      const made = createHttpGenerationProvider({
        provider,
        baseUrl: 'http://localhost:8080',
        model: 'qwen3',
        fetch: vi.fn(async () => answer(body)) as unknown as typeof globalThis.fetch,
      });
      await expect(made.generate(ask)).rejects.toBeInstanceOf(GenerationError);
    }
  });

  it('answers null for a cost the provider did not report', async () => {
    const provider = createHttpGenerationProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:8080',
      model: 'qwen3',
      fetch: vi.fn(async () =>
        answer({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      ) as unknown as typeof globalThis.fetch,
    });
    expect((await provider.generate(ask)).usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('refuses to ask a model for nothing', async () => {
    const fetch = vi.fn(async () => answer(openai('ok')));
    const provider = createHttpGenerationProvider({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(provider.generate({ instruction: '  ', input: 'text' })).rejects.toBeInstanceOf(
      GenerationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names what produced an answer', async () => {
    const provider = createHttpGenerationProvider({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:8b',
      fetch: vi.fn(async () => answer(ollama('ok'))) as unknown as typeof globalThis.fetch,
    });
    expect(provider.profile).toEqual({ provider: 'ollama', model: 'qwen3:8b' });
  });
});
