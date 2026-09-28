/**
 * What a transcription provider is, from the domain's side.
 *
 * One method: a recording goes in, its words come out. Which HTTP shape and
 * which field carries the file is the adapter's business, and nothing in the
 * domain may require one (rule 9) — without it a recording is a file that is
 * kept and can be downloaded, and nothing else changes.
 */
export interface TranscriptionProvider {
  readonly profile: TranscriptionProfile;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TranscriptionProfile {
  provider: string;
  model: string;
}

export interface TranscriptionRequest {
  bytes: Uint8Array;
  /** What the file is called, which is how a provider guesses the container. */
  filename: string;
  mediaType: string;
}

export interface TranscriptionResult {
  text: string;
}

export class TranscriptionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TranscriptionError';
  }
}

export interface HttpTranscriptionOptions {
  /**
   * `openai_compatible` only.
   *
   * Ollama has no transcription endpoint, so an installation whose only provider
   * is Ollama has nothing to assign here — which the settings screen says rather
   * than letting somebody choose a model that cannot be asked.
   */
  provider: 'openai_compatible';
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /**
   * Generous: an hour of audio is minutes of work on somebody's own machine.
   *
   * Whatever this is, it has to stay under the window a file's claim is believed
   * for — `STALE_CLAIM_MS` in the extractor — or a sweep takes a recording that
   * is still being transcribed.
   */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export const TRANSCRIPTION_TIMEOUT_MS = 600_000;

/** What can be sent, or null when nothing here can talk to that provider. */
export type TranscriptionSource = () => Promise<TranscriptionProvider | null>;

export function fixedTranscriptionSource(
  provider: TranscriptionProvider | null,
): TranscriptionSource {
  return async () => provider;
}

/**
 * A transcription provider over HTTP.
 *
 * `POST <base>/v1/audio/transcriptions`, multipart, which is the shape OpenAI
 * defined and every local Whisper server imitates. The file goes as it arrived:
 * a container this product cannot open is one the provider may well be able to,
 * and demuxing it here would mean a media toolchain in the image for a job
 * somebody else's server already does.
 */
export function createHttpTranscriptionProvider(
  options: HttpTranscriptionOptions,
): TranscriptionProvider {
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/+$/u, '');

  return {
    get profile(): TranscriptionProfile {
      return { provider: options.provider, model: options.model };
    },
    async transcribe(request) {
      const form = new FormData();
      form.append('model', options.model);
      // No language: what was spoken is not something this product knows, and a
      // workspace's own language is a guess about somebody else's recording.
      // Every one of these endpoints detects it, and detecting beats guessing.
      form.append('file', new Blob([request.bytes], { type: request.mediaType }), request.filename);

      let response: Response;
      try {
        response = await call(`${base}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new TranscriptionError(`the model at ${base} could not be reached`, error);
      }
      if (!response.ok) {
        // The status and nothing else: the body may quote what was heard, and
        // what was heard is somebody's recording.
        throw new TranscriptionError(`the model at ${base} answered ${response.status}`);
      }
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload?.text !== 'string') {
        throw new TranscriptionError(`the model at ${base} answered without a transcript`);
      }
      return { text: payload.text };
    },
  };
}
