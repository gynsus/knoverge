import { EmbeddingError } from './embeddings.ts';

/** What a probe found at an address. */
export interface ProviderCatalogue {
  /** The server's own version string, when it offers one. */
  version?: string;
  models: CatalogueModel[];
}

export interface CatalogueModel {
  name: string;
  /** Bytes on the provider's disk, when it says. */
  size?: number;
  /**
   * What the model can do, when the provider says.
   *
   * Empty means it did not say, not that the model can do nothing: only Ollama
   * reports this, and a picker that hid every model from a server which does
   * not report capabilities would offer nothing at all.
   */
  capabilities: string[];
}

export interface ProbeOptions {
  kind: 'ollama' | 'openai_compatible';
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Ask an address what it is and what it holds.
 *
 * This is what the connection wizard runs against a URL somebody typed, before
 * anything is saved: a form that can only test what has already been stored
 * teaches people to store things that do not work.
 *
 * It answers a shape, never a body. The provider is somebody else's server and
 * its errors may quote a request.
 */
export async function probeProvider(options: ProbeOptions): Promise<ProviderCatalogue> {
  const call = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const get = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await call(`${base}${path}`, {
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new EmbeddingError(`nothing answered at ${base}`, error);
    }
    if (!response.ok) throw new EmbeddingError(`${base} answered ${response.status}`);
    return response.json();
  };

  if (options.kind === 'ollama') {
    const tags = (await get('/api/tags')) as { models?: unknown };
    const models = Array.isArray(tags.models) ? tags.models.map(ollamaModel) : [];
    // The version is a courtesy: knowing which Ollama answered helps an
    // operator, and an older one without the route must not fail the probe.
    let version: string | undefined;
    try {
      const answer = (await get('/api/version')) as { version?: unknown };
      if (typeof answer.version === 'string') version = answer.version;
    } catch {
      version = undefined;
    }
    return { models, ...(version ? { version } : {}) };
  }

  const listing = (await get('/v1/models')) as { data?: unknown };
  const data = Array.isArray(listing.data) ? listing.data : [];
  return {
    models: data.map((entry) => ({
      name: String((entry as Record<string, unknown>)['id'] ?? ''),
      // The OpenAI listing says nothing about what a model is for.
      capabilities: [],
    })),
  };
}

function ollamaModel(entry: unknown): CatalogueModel {
  const record = (entry ?? {}) as Record<string, unknown>;
  const capabilities = record['capabilities'];
  const size = record['size'];
  return {
    name: String(record['name'] ?? record['model'] ?? ''),
    capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
    ...(typeof size === 'number' ? { size } : {}),
  };
}
