import type {
  TtsProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';

export class OpenAiTtsProvider implements TtsProvider {
  readonly name = 'openai-tts';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultVoice: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; voice?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'tts-1';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.defaultVoice = opts.voice ?? 'alloy';
    this.caps = {
      kind: 'tts',
      formats: ['opus'],
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      local: false,
      maxInputChars: 4096,
      contractVersion: 1,
    };
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; speed?: number },
  ): Promise<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm' }> {
    const voice = opts?.voice ?? this.defaultVoice;
    const speed = opts?.speed ?? 1.0;

    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice,
        speed,
        response_format: 'opus',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI TTS failed (${res.status}): ${body}`);
    }

    const buffer = await res.arrayBuffer();
    return { audio: new Uint8Array(buffer), format: 'opus' };
  }
}

export function openaiTtsFactory(ctx: VoiceProviderFactoryContext): OpenAiTtsProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('OpenAI TTS requires apiKey');
  return new OpenAiTtsProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
    voice: ctx.config.voice as string | undefined,
  });
}
