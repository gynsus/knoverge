import type { TranscriptionSource } from '@knoverge/intelligence';

/** What a recording turned out to say, and which model heard it. */
export interface Transcript {
  text: string;
  /** The model's own name, for `drafted_by` on the item it becomes (ADR 0031). */
  model: string;
}

export interface MediaTranscriberOptions {
  /** What can listen now, or null when nothing can (rule 9). */
  transcription: TranscriptionSource;
}

/**
 * Recordings this asks a model about.
 *
 * Video as well as audio, and the file goes as it arrived: a container this
 * product cannot open is one a transcription service opens every day, and
 * demuxing it here would put a media toolchain in the image for a job somebody
 * else's server already does.
 */
const HEARABLE = /^(audio\/|video\/)/u;

export function isHearable(mediaType: string): boolean {
  return HEARABLE.test((mediaType.split(';')[0] ?? '').trim().toLowerCase());
}

/**
 * Turning a recording into words, when an installation has something that can.
 *
 * The same shape as the describer, for the same reasons: optional, asked only
 * about what nothing here could read, and what it produces is ordinary knowledge
 * that says which model phrased it. A transcript is a model's account of
 * somebody's recording, and a reader has to know that it is (ADR 0031).
 *
 * There is no instruction to send. A transcription endpoint takes a file and
 * returns what was said — which also means there is nothing here for a recording
 * to give instructions *to*: what a voice says arrives as text, and text is what
 * it becomes.
 */
export class MediaTranscriber {
  private readonly o: MediaTranscriberOptions;

  constructor(options: MediaTranscriberOptions) {
    this.o = options;
  }

  async transcribe(
    mediaType: string,
    bytes: Uint8Array,
    filename: string,
  ): Promise<Transcript | null> {
    if (!isHearable(mediaType)) return null;
    const model = await this.o.transcription();
    if (!model) return null;
    const answer = await model.transcribe({ bytes, filename, mediaType });
    const text = answer.text.trim();
    if (text === '') return null;
    return { text, model: model.profile.model };
  }
}
