/**
 * What a text-generation provider is, from the domain's side.
 *
 * One method, like the embedding port: an instruction and the material it may
 * use go in, one answer comes out. Which HTTP shape, which header carries the
 * key, how the answer is nested — all the adapter's business.
 *
 * Nothing in the domain may require one (rule 9). A summary can be written by
 * hand, and a digest counts what happened whether or not anything can narrate
 * it; this is what makes those two things easier, never what makes them work.
 */
export interface GenerationProvider {
  /** Names what produced an answer, so a generated item can say where it came from. */
  readonly profile: GenerationProfile;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

/** Which provider, which model. No dimension: there is nothing to keep in step. */
export interface GenerationProfile {
  provider: string;
  model: string;
}

export interface GenerationRequest {
  /**
   * What the model is being asked to do, in the product's own words.
   *
   * Separate from `input` because they are separate things: one is the
   * product's instruction and the other is knowledge somebody else wrote. A
   * provider that supports a system role gets them apart, which is the only
   * defence there is against material that tries to give instructions.
   */
  instruction: string;
  /** The material it may use, and nothing else. */
  input: string;
  /** A ceiling, because a model that will not stop must not fill a file. */
  maxOutputTokens?: number;
  /** Low by default: this summarises knowledge rather than inventing prose. */
  temperature?: number;
}

export interface GenerationResult {
  text: string;
  /** What it cost, when the provider says; null when it does not. */
  usage: { inputTokens: number | null; outputTokens: number | null };
  /**
   * Whether the model stopped because it ran out of room rather than because
   * it had finished.
   *
   * Worth knowing: a summary cut off mid-sentence is a summary nobody should
   * store, and the answer alone does not say which happened.
   */
  truncated: boolean;
}

export class GenerationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GenerationError';
  }
}

export interface HttpGenerationOptions {
  /** `openai_compatible` or `ollama`; they differ in path and in shape. */
  provider: 'openai_compatible' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** Bounded, because a provider that never answers must not hold a job. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;

/**
 * A generation provider over HTTP.
 *
 * Two shapes, the same two the embedding adapter covers: the OpenAI
 * `/v1/chat/completions` body that most gateways and local servers imitate, and
 * Ollama's own `/api/chat`. Both take a system message and a user message, so
 * the instruction and the material stay apart on the wire as well as in the
 * request.
 *
 * The timeout is much longer than the embedding one. Embedding a passage is
 * milliseconds of arithmetic; generating a paragraph on somebody's laptop GPU
 * is tens of seconds, and a ceiling tuned for the first turns the second into a
 * feature that never works.
 */
export function createHttpGenerationProvider(options: HttpGenerationOptions): GenerationProvider {
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/+$/u, '');

  return {
    get profile(): GenerationProfile {
      return { provider: options.provider, model: options.model };
    },
    async generate(request) {
      const instruction = request.instruction.trim();
      const input = request.input.trim();
      if (instruction === '') throw new GenerationError('a generation needs an instruction');
      const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const temperature = request.temperature ?? DEFAULT_TEMPERATURE;
      const messages = [
        { role: 'system', content: instruction },
        { role: 'user', content: input },
      ];
      const url =
        options.provider === 'ollama' ? `${base}/api/chat` : `${base}/v1/chat/completions`;
      const body =
        options.provider === 'ollama'
          ? {
              model: options.model,
              messages,
              stream: false,
              options: { temperature, num_predict: maxTokens },
            }
          : { model: options.model, messages, temperature, max_tokens: maxTokens };

      let response: Response;
      try {
        response = await call(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new GenerationError(`the model at ${base} could not be reached`, error);
      }
      if (!response.ok) {
        // The body may quote the prompt, and the prompt is knowledge. The
        // status is what an operator needs and the only thing safe to log.
        throw new GenerationError(`the model at ${base} answered ${response.status}`);
      }
      return answerFrom((await response.json()) as unknown, options.provider, base);
    },
  };
}

/** Both shapes, read defensively: this is somebody else's server. */
function answerFrom(
  payload: unknown,
  provider: 'openai_compatible' | 'ollama',
  base: string,
): GenerationResult {
  const object = payload as Record<string, unknown> | null;
  if (!object || typeof object !== 'object') {
    throw new GenerationError(`the model at ${base} answered something that is not an object`);
  }
  if (provider === 'ollama') {
    const message = object['message'] as Record<string, unknown> | undefined;
    const text = message?.['content'];
    if (typeof text !== 'string') {
      throw new GenerationError(`the model at ${base} answered without a message`);
    }
    return {
      text: text.trim(),
      usage: {
        inputTokens: count(object['prompt_eval_count']),
        outputTokens: count(object['eval_count']),
      },
      // Ollama says why it stopped, and `length` is the one that matters.
      truncated: object['done_reason'] === 'length',
    };
  }
  const choices = object['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GenerationError(`the model at ${base} answered without any choices`);
  }
  const choice = choices[0] as Record<string, unknown>;
  const text = (choice['message'] as Record<string, unknown> | undefined)?.['content'];
  if (typeof text !== 'string') {
    throw new GenerationError(`the model at ${base} answered without a message`);
  }
  const usage = object['usage'] as Record<string, unknown> | undefined;
  return {
    text: text.trim(),
    usage: {
      inputTokens: count(usage?.['prompt_tokens']),
      outputTokens: count(usage?.['completion_tokens']),
    },
    truncated: choice['finish_reason'] === 'length',
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * What the generation provider is *now*.
 *
 * Asked again on every use rather than held since start-up, for the reason the
 * embedding source is: an operator connects one, changes the model and
 * disconnects it while the product runs (ADR 0021). Null stays the ordinary
 * answer.
 */
export type GenerationSource = () => Promise<GenerationProvider | null>;

/** A source that is always this, for tests and for nothing configured. */
export function fixedGenerationSource(provider: GenerationProvider | null): GenerationSource {
  return () => Promise.resolve(provider);
}
