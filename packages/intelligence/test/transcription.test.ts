import { describe, expect, it } from 'vitest';

import { TranscriptionError, createHttpTranscriptionProvider } from '../src/transcription.ts';

const CLIP = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);

function provider(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    made: createHttpTranscriptionProvider({
      provider: 'openai_compatible',
      baseUrl: 'http://listener.test:8000/',
      model: 'whisper-1',
      apiKey: 'sk-test',
      fetch: (async (url: string | URL | Request, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init);
      }) as unknown as typeof globalThis.fetch,
    }),
  };
}

function said(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('asking a server to listen', () => {
  it('sends the file as a form, to the endpoint every whisper server offers', async () => {
    const it_ = provider(() => said({ text: 'Support closes at five.' }));
    const answer = await it_.made.transcribe({
      bytes: CLIP,
      filename: 'standup.mp3',
      mediaType: 'audio/mpeg',
    });

    expect(answer.text).toBe('Support closes at five.');
    // The trailing slash on the configured address does not become a double one.
    expect(it_.calls[0]?.url).toBe('http://listener.test:8000/v1/audio/transcriptions');
    const form = it_.calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-1');
    // Under its own name, because that is how a provider guesses the container.
    const file = form.get('file') as File;
    expect(file.name).toBe('standup.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(await file.arrayBuffer()).toEqual(CLIP.buffer);
  });

  it('carries the key when one is configured', async () => {
    const it_ = provider(() => said({ text: 'x' }));
    await it_.made.transcribe({ bytes: CLIP, filename: 'a.mp3', mediaType: 'audio/mpeg' });
    expect((it_.calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('says the status and nothing else, because the body may quote the recording', async () => {
    const it_ = provider(() => said({ error: { message: 'heard: my card number is 4111' } }, 400));
    await expect(
      it_.made.transcribe({ bytes: CLIP, filename: 'a.mp3', mediaType: 'audio/mpeg' }),
    ).rejects.toThrow(TranscriptionError);
    await expect(
      it_.made.transcribe({ bytes: CLIP, filename: 'a.mp3', mediaType: 'audio/mpeg' }),
    ).rejects.toThrow(/answered 400$/u);
  });

  it('refuses an answer that is not a transcript rather than inventing one', async () => {
    const it_ = provider(() => said({ segments: [] }));
    await expect(
      it_.made.transcribe({ bytes: CLIP, filename: 'a.mp3', mediaType: 'audio/mpeg' }),
    ).rejects.toThrow(/without a transcript/u);
  });

  it('says where it could not reach, when it could not reach it', async () => {
    const it_ = provider(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      it_.made.transcribe({ bytes: CLIP, filename: 'a.mp3', mediaType: 'audio/mpeg' }),
    ).rejects.toThrow(/http:\/\/listener\.test:8000 could not be reached/u);
  });
});
