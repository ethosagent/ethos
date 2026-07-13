import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, SecretsResolver, VoiceProviderFactoryContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateVoiceCaps } from '../conformance';
import { localSttFactory } from '../local-stt';
import { localTtsFactory } from '../local-tts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const noopSecrets: SecretsResolver = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

function ctx(config: Record<string, unknown>): VoiceProviderFactoryContext {
  return { config, secrets: noopSecrets, logger: noopLogger };
}

describe('local-stt provider', () => {
  let dir: string;
  let audioPath: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-stt-'));
    audioPath = join(dir, 'clip.ogg');
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('builds with caps.local:true and passes conformance', () => {
    const provider = localSttFactory(ctx({}));
    expect(provider.name).toBe('local-stt');
    expect(provider.caps.local).toBe(true);
    expect(validateVoiceCaps(provider.caps)).toEqual([]);
  });

  it('applies Whisper defaults (localhost:8000, whisper-large-v3) with no api key', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = localSttFactory(ctx({}));
    await provider.transcribe(audioPath);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions');
    expect((init.body as FormData).get('model')).toBe('whisper-large-v3');
    expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
  });

  it('honours a free-form baseUrl, model, and optional apiKey', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = localSttFactory(
      ctx({
        baseUrl: 'http://box.lan:9001/v1',
        model: 'Systran/faster-whisper-large-v3',
        apiKey: 'local-key',
      }),
    );
    await provider.transcribe(audioPath);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://box.lan:9001/v1/audio/transcriptions');
    expect((init.body as FormData).get('model')).toBe('Systran/faster-whisper-large-v3');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer local-key');
  });
});

describe('local-tts provider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('builds with caps.local:true and passes conformance', () => {
    const provider = localTtsFactory(ctx({}));
    expect(provider.name).toBe('local-tts');
    expect(provider.caps.local).toBe(true);
    expect(validateVoiceCaps(provider.caps)).toEqual([]);
  });

  it('applies Kokoro defaults (localhost:8880, kokoro) with no api key', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(new Uint8Array([1]).buffer),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = localTtsFactory(ctx({}));
    await provider.synthesize('hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8880/v1/audio/speech');
    expect(JSON.parse(init.body as string).model).toBe('kokoro');
    expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
  });

  it('passes an arbitrary free-form config voice straight through', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(new Uint8Array([1]).buffer),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = localTtsFactory(ctx({ voice: 'am_totally_custom_voice' }));
    await provider.synthesize('hello');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).voice).toBe('am_totally_custom_voice');
  });

  it('per-call opts.voice overrides the config voice', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(new Uint8Array([1]).buffer),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = localTtsFactory(ctx({ voice: 'af_bella' }));
    await provider.synthesize('hello', { voice: 'af_override' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).voice).toBe('af_override');
  });
});
