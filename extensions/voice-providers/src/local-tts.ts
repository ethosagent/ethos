import type {
  TtsProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { synthesizeOpenAiCompat } from './openai-compat';

// Local TTS over an OpenAI-compatible endpoint (e.g. kokoro-fastapi). API key is
// OPTIONAL — local servers usually need none. `voice` is a free-form, server-
// specific id (Kokoro: `af_bella`, `am_adam`, …) passed straight through, so no
// fixed voice list is enforced (`caps.voices` is omitted).
export class LocalTtsProvider implements TtsProvider {
  readonly name = 'local-tts';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultVoice: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string; voice?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'kokoro';
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8880/v1';
    this.defaultVoice = opts.voice ?? 'af_bella';
    this.caps = {
      kind: 'tts',
      formats: ['opus'],
      local: true,
      contractVersion: 1,
    };
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): Promise<{ audio: Uint8Array; format: 'opus' }> {
    const voice = opts?.voice ?? this.defaultVoice;
    const speed = opts?.speed ?? 1.0;

    return synthesizeOpenAiCompat({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      voice,
      input: text,
      speed,
      label: 'Local TTS',
      signal: opts?.signal,
    });
  }
}

export function localTtsFactory(ctx: VoiceProviderFactoryContext): LocalTtsProvider {
  return new LocalTtsProvider({
    apiKey: ctx.config.apiKey as string | undefined,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
    voice: ctx.config.voice as string | undefined,
  });
}
