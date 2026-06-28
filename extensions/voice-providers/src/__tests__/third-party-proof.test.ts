import { DefaultTtsProviderRegistry } from '@ethosagent/core';
import type {
  Logger,
  SecretsResolver,
  TtsProvider,
  TtsProviderFactory,
  VoiceCapabilities,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs-tts';
  readonly caps: VoiceCapabilities = {
    kind: 'tts',
    formats: ['mp3'],
    voices: ['rachel', 'drew', 'clyde', 'paul', 'domi', 'dave'],
    local: false,
    maxInputChars: 5000,
    contractVersion: 1,
  };

  private readonly apiKey: string;

  constructor(opts: { apiKey: string; voiceId?: string }) {
    this.apiKey = opts.apiKey;
  }

  async synthesize(
    _text: string,
    _opts?: { voice?: string; speed?: number },
  ): Promise<{ audio: Uint8Array; format: 'mp3' }> {
    // In a real plugin, this would call the ElevenLabs API.
    // For the proof, we just verify the interface is satisfied.
    return { audio: new Uint8Array([0x49, 0x44, 0x33]), format: 'mp3' };
  }
}

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

const elevenLabsFactory: TtsProviderFactory = (ctx) => {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('ElevenLabs requires apiKey');
  return new ElevenLabsTtsProvider({ apiKey });
};

describe('Third-party provider proof (ElevenLabs TTS)', () => {
  it('registers and resolves from the registry with zero core edits', () => {
    const registry = new DefaultTtsProviderRegistry();

    // A third-party plugin calls registerTtsProvider which delegates to registry.register
    registry.register('elevenlabs-tts', elevenLabsFactory);

    // The gateway resolves by name from the registry
    const factory = registry.get('elevenlabs-tts');
    expect(factory).toBeDefined();

    // Factory produces a valid provider
    const provider = factory?.({
      config: { apiKey: 'test-key-123' },
      secrets: noopSecrets,
      logger: noopLogger,
    });

    expect(provider).toBeDefined();
  });

  it('provider satisfies TtsProvider contract', async () => {
    const provider = new ElevenLabsTtsProvider({ apiKey: 'test' });

    expect(provider.name).toBe('elevenlabs-tts');
    expect(provider.caps.kind).toBe('tts');
    expect(provider.caps.formats).toContain('mp3');
    expect(provider.caps.local).toBe(false);
    expect(typeof provider.synthesize).toBe('function');

    const result = await provider.synthesize('Hello world');
    expect(result.format).toBe('mp3');
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(provider.caps.formats).toContain(result.format);
  });

  it('built-in names cannot be shadowed', () => {
    const registry = new DefaultTtsProviderRegistry();
    registry.register('openai-tts', elevenLabsFactory);

    // Attempting to register with the same name throws
    expect(() => registry.register('openai-tts', elevenLabsFactory)).toThrow(/already registered/);
  });

  it('config selects the third-party provider by name', () => {
    const registry = new DefaultTtsProviderRegistry();

    // Built-in
    registry.register('openai-tts', () => ({
      name: 'openai-tts',
      caps: { kind: 'tts', formats: ['opus'], contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array(0), format: 'opus' as const }),
    }));

    // Third-party
    registry.register('elevenlabs-tts', elevenLabsFactory);

    // Config says: auxiliary.tts.provider: elevenlabs-tts
    const providerName = 'elevenlabs-tts';
    const factory = registry.get(providerName);
    expect(factory).toBeDefined();

    // The provider is ElevenLabs, not OpenAI
    const provider = factory?.({
      config: { apiKey: 'test' },
      secrets: noopSecrets,
      logger: noopLogger,
    });
    expect(provider?.name).toBe('elevenlabs-tts');
  });
});
