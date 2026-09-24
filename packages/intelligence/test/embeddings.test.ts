import { describe, expect, it, vi } from 'vitest';

import { EmbeddingError, createHttpEmbeddingProvider } from '../src/index.ts';

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('an embedding provider over HTTP', () => {
  it('reads the OpenAI shape, and sends the key as a bearer', async () => {
    const fetch = vi.fn(async () => answer({ data: [{ embedding: [0.1, 0.2] }] }));
    const provider = createHttpEmbeddingProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:11434/',
      model: 'bge-m3',
      apiKey: 'secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(await provider.embed(['hello'])).toEqual([[0.1, 0.2]]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // The trailing slash of the base does not become a double slash.
    expect(url).toBe('http://localhost:11434/v1/embeddings');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret');
  });

  it('reads the Ollama shape, at its own path', async () => {
    const fetch = vi.fn(async () => answer({ embeddings: [[1, 2, 3]] }));
    const provider = createHttpEmbeddingProvider({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'nomic-embed-text',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(await provider.embed(['hello'])).toEqual([[1, 2, 3]]);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://localhost:11434/api/embed',
    );
  });

  it('learns the dimension from the model rather than being told it', async () => {
    // A number an operator has to keep in step with their model is a number
    // that will eventually be wrong, and vectors compared against vectors of
    // another shape fail without a symptom.
    const fetch = vi.fn(async () => answer({ embeddings: [[1, 2, 3, 4]] }));
    const provider = createHttpEmbeddingProvider({
      provider: 'ollama',
      baseUrl: 'http://x',
      model: 'm',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(provider.profile.dimensions).toBe(0);
    await provider.embed(['hello']);
    expect(provider.profile).toEqual({ provider: 'ollama', model: 'm', dimensions: 4 });
  });

  it('batches, and keeps the order it was given', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      return answer({ embeddings: [[call], [call]] });
    });
    const provider = createHttpEmbeddingProvider({
      provider: 'ollama',
      baseUrl: 'http://x',
      model: 'm',
      batch: 2,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await provider.embed(['a', 'b', 'c', 'd'])).toEqual([[1], [1], [2], [2]]);
  });

  it('refuses an answer that does not line up with what was asked', async () => {
    // Fewer vectors than texts, silently accepted, attaches them to the wrong
    // chunks — which is wrong in a way nothing downstream can notice.
    const fetch = vi.fn(async () => answer({ embeddings: [[1]] }));
    const provider = createHttpEmbeddingProvider({
      provider: 'ollama',
      baseUrl: 'http://x',
      model: 'm',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(provider.embed(['a', 'b'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('refuses a model that changes its mind about the dimension', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      return answer({ embeddings: [call === 1 ? [1, 2] : [1, 2, 3]] });
    });
    const provider = createHttpEmbeddingProvider({
      provider: 'ollama',
      baseUrl: 'http://x',
      model: 'm',
      batch: 1,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/3 numbers after 2/);
  });

  it('says what happened without repeating what the provider said', async () => {
    // A provider's error body may carry a key or the text that was sent.
    const fetch = vi.fn(async () => answer({ error: 'api key sk-live-123 is invalid' }, 401));
    const provider = createHttpEmbeddingProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://x',
      model: 'm',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/answered 401/);
    await expect(provider.embed(['a'])).rejects.not.toThrow(/sk-live/);
  });

  it('asks for nothing when there is nothing to embed', async () => {
    const fetch = vi.fn();
    const provider = createHttpEmbeddingProvider({
      provider: 'ollama',
      baseUrl: 'http://x',
      model: 'm',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await provider.embed([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
