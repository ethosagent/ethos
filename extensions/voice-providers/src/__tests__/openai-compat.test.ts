import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeOpenAiCompat, transcribeOpenAiCompat } from '../openai-compat';

describe('openai-compat shared transport', () => {
  let dir: string;
  let audioPath: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-compat-'));
    audioPath = join(dir, 'clip.ogg');
    await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  describe('transcribeOpenAiCompat', () => {
    it('POSTs multipart to {baseUrl}/audio/transcriptions with file + model', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(JSON.stringify({ text: 'hi there' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const text = await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'whisper-large-v3',
        audioPath,
        label: 'Local STT',
      });

      expect(text).toBe('hi there');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8000/v1/audio/transcriptions');
      expect(init.method).toBe('POST');
      const body = init.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get('model')).toBe('whisper-large-v3');
      expect(body.get('file')).toBeInstanceOf(Blob);
    });

    it('sends Authorization when an apiKey is present', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'https://api.openai.com/v1',
        model: 'whisper-1',
        audioPath,
        apiKey: 'sk-secret',
        label: 'OpenAI STT',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    });

    it('omits Authorization entirely when no apiKey (local case)', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'whisper-large-v3',
        audioPath,
        label: 'Local STT',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
    });

    it('throws with the label prefix on a non-ok response', async () => {
      globalThis.fetch = vi.fn(
        async () => new Response('boom', { status: 500 }),
      ) as unknown as typeof fetch;

      await expect(
        transcribeOpenAiCompat({
          baseUrl: 'http://localhost:8000/v1',
          model: 'm',
          audioPath,
          label: 'Local STT',
        }),
      ).rejects.toThrow(/Local STT failed \(500\)/);
    });
  });

  describe('synthesizeOpenAiCompat', () => {
    it('POSTs json to {baseUrl}/audio/speech and returns opus bytes', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(new Uint8Array([9, 8, 7]).buffer),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await synthesizeOpenAiCompat({
        baseUrl: 'http://localhost:8880/v1',
        model: 'kokoro',
        voice: 'af_bella',
        input: 'hello',
        label: 'Local TTS',
      });

      expect(result.format).toBe('opus');
      expect(Array.from(result.audio)).toEqual([9, 8, 7]);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8880/v1/audio/speech');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      const parsed = JSON.parse(init.body as string);
      expect(parsed).toMatchObject({
        model: 'kokoro',
        voice: 'af_bella',
        input: 'hello',
        response_format: 'opus',
      });
    });

    it('sends Authorization when an apiKey is present', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(new Uint8Array([0]).buffer),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await synthesizeOpenAiCompat({
        baseUrl: 'https://api.openai.com/v1',
        model: 'tts-1',
        voice: 'alloy',
        input: 'hi',
        apiKey: 'sk-cloud',
        label: 'OpenAI TTS',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-cloud');
    });

    it('omits Authorization entirely when no apiKey (local case)', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(new Uint8Array([0]).buffer),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await synthesizeOpenAiCompat({
        baseUrl: 'http://localhost:8880/v1',
        model: 'kokoro',
        voice: 'af_bella',
        input: 'hi',
        label: 'Local TTS',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
    });
  });
});
