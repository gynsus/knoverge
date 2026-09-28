import { describe, expect, it } from 'vitest';

import { TRANSCRIPTION_TIMEOUT_MS } from '@knoverge/intelligence';

import { STALE_CLAIM_MS } from '../src/attachments/extraction.ts';
import { MediaTranscriber, isHearable } from '../src/attachments/transcription.ts';

const CLIP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56]);

function listener(text = 'Support closes at five, every weekday.') {
  const calls: { filename: string; mediaType: string }[] = [];
  return {
    calls,
    source: async () => ({
      profile: { provider: 'openai_compatible', model: 'whisper-1' },
      transcribe: async (request: { bytes: Uint8Array; filename: string; mediaType: string }) => {
        calls.push({ filename: request.filename, mediaType: request.mediaType });
        return { text };
      },
    }),
  };
}

describe('what can be listened to', () => {
  it('is a recording, whether it carries pictures or not', () => {
    expect(isHearable('audio/mpeg')).toBe(true);
    expect(isHearable('audio/wav; codecs=1')).toBe(true);
    // Video too, and as it arrived: a container this product cannot open is one
    // a transcription service opens every day, and demuxing it here would mean a
    // media toolchain in the image for a job somebody else already does.
    expect(isHearable('video/mp4')).toBe(true);
    expect(isHearable('image/png')).toBe(false);
    expect(isHearable('application/pdf')).toBe(false);
  });
});

describe('turning a recording into words', () => {
  it('sends the file as it arrived, under the name it arrived with', async () => {
    const heard = listener();
    const transcript = await new MediaTranscriber({
      transcription: heard.source as never,
    }).transcribe('audio/mpeg', CLIP, 'standup-2026-09-28.mp3');
    expect(transcript?.text).toContain('Support closes at five');
    // The model's name, for `drafted_by`: a transcript is a model's account of
    // somebody's recording (ADR 0031).
    expect(transcript?.model).toBe('whisper-1');
    // The filename goes with it, because it is how a provider guesses the
    // container when the media type is vague.
    expect(heard.calls[0]?.filename).toBe('standup-2026-09-28.mp3');
    expect(heard.calls[0]?.mediaType).toBe('audio/mpeg');
  });

  it('answers nothing when this installation has nothing that listens', async () => {
    const transcript = await new MediaTranscriber({ transcription: async () => null }).transcribe(
      'audio/mpeg',
      CLIP,
      'standup.mp3',
    );
    expect(transcript).toBeNull();
  });

  it('answers nothing for silence, rather than an item that says nothing', async () => {
    const heard = listener('   ');
    expect(
      await new MediaTranscriber({ transcription: heard.source as never }).transcribe(
        'audio/mpeg',
        CLIP,
        'silence.mp3',
      ),
    ).toBeNull();
  });

  it('does not offer a file that is not a recording', async () => {
    const heard = listener();
    expect(
      await new MediaTranscriber({ transcription: heard.source as never }).transcribe(
        'text/plain',
        CLIP,
        'notes.txt',
      ),
    ).toBeNull();
    expect(heard.calls).toHaveLength(0);
  });
});

describe('how long a file may take', () => {
  it('is less than how long its claim is believed', () => {
    // Otherwise the next sweep takes a recording the first worker is still
    // transcribing: the same file paid for twice, and two documents from it.
    expect(TRANSCRIPTION_TIMEOUT_MS).toBeLessThan(STALE_CLAIM_MS);
  });
});
