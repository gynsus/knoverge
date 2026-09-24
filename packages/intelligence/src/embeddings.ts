/**
 * What an embedding provider is, from the domain's side.
 *
 * One method, because that is all the domain needs: text in, vectors out, in
 * the order they were given. Everything else — which HTTP shape, which header
 * carries the key, how many at a time — is the adapter's business.
 */
export interface EmbeddingProvider {
  /** Names what produced a vector, so two models are never compared. */
  readonly profile: EmbeddingProfile;
  /**
   * Vectors for these texts, in the same order.
   *
   * Throws rather than returning a short array: a caller that silently got
   * fewer vectors than texts would attach them to the wrong chunks.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Which provider, which model, how many numbers. */
export interface EmbeddingProfile {
  provider: string;
  model: string;
  dimensions: number;
}

export class EmbeddingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'EmbeddingError';
  }
}

export interface HttpEmbeddingOptions {
  /** `openai_compatible` or `ollama`; they differ only in shape. */
  provider: 'openai_compatible' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** How many texts go in one request. */
  batch?: number;
  /** Bounded, because a provider that never answers must not hold a job. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_BATCH = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * An embedding provider over HTTP.
 *
 * Two shapes, because between them they cover what a self-hosted installation
 * is likely to have: the OpenAI `/v1/embeddings` body, which most gateways and
 * local servers imitate, and Ollama's own `/api/embed`.
 *
 * The dimension is not configured. It is whatever the model returns, read from
 * the first answer: a number an operator has to keep in step with their model
 * is a number that will eventually be wrong, and the consequence — vectors
 * compared against vectors of another shape — has no symptom.
 */
export function createHttpEmbeddingProvider(options: HttpEmbeddingOptions): EmbeddingProvider {
  const call = options.fetch ?? globalThis.fetch;
  const batchSize = options.batch ?? DEFAULT_BATCH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/+$/u, '');
  let dimensions = 0;

  const request = async (texts: readonly string[]): Promise<number[][]> => {
    const url = options.provider === 'ollama' ? `${base}/api/embed` : `${base}/v1/embeddings`;
    // The request bodies happen to agree; only the path and the answer differ.
    const body = { model: options.model, input: [...texts] };
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await call(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new EmbeddingError(`the embedding provider at ${base} could not be reached`, error);
    }
    if (!response.ok) {
      // The body may carry a key or a prompt; the status is what an operator
      // needs and the only thing safe to log.
      throw new EmbeddingError(`the embedding provider at ${base} answered ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const vectors = vectorsFrom(payload, options.provider);
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        `asked for ${texts.length} embeddings and received ${vectors.length}`,
      );
    }
    return vectors;
  };

  return {
    get profile(): EmbeddingProfile {
      return { provider: options.provider, model: options.model, dimensions };
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const vectors = await request(texts.slice(i, i + batchSize));
        for (const vector of vectors) {
          if (dimensions === 0) dimensions = vector.length;
          if (vector.length !== dimensions) {
            throw new EmbeddingError(
              `the model returned ${vector.length} numbers after ${dimensions}`,
            );
          }
          out.push(vector);
        }
      }
      return out;
    },
  };
}

/** Both shapes, read defensively: this is somebody else's server. */
function vectorsFrom(payload: unknown, provider: 'openai_compatible' | 'ollama'): number[][] {
  const object = payload as Record<string, unknown> | null;
  if (!object || typeof object !== 'object') {
    throw new EmbeddingError('the embedding provider answered something that is not an object');
  }
  if (provider === 'ollama') {
    const embeddings = object['embeddings'];
    if (!Array.isArray(embeddings)) {
      throw new EmbeddingError('the embedding provider answered without `embeddings`');
    }
    return embeddings.map(numbers);
  }
  const data = object['data'];
  if (!Array.isArray(data)) {
    throw new EmbeddingError('the embedding provider answered without `data`');
  }
  return data.map((entry) => numbers((entry as Record<string, unknown> | null)?.['embedding']));
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new EmbeddingError('an embedding was not a list of numbers');
  }
  return value as number[];
}

/**
 * What the embedding provider is *now*.
 *
 * Not an `EmbeddingProvider | null` held since start-up, because an operator
 * connects one, changes the model and disconnects it while the product runs
 * (ADR 0021). Every consumer asks again, and null stays the ordinary answer.
 */
export type EmbeddingSource = () => Promise<EmbeddingProvider | null>;

/** A source that is always this, for tests and for nothing configured. */
export function fixedSource(provider: EmbeddingProvider | null): EmbeddingSource {
  return () => Promise.resolve(provider);
}
