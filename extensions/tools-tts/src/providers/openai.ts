import type { TtsProvider } from '../index';

export interface OpenAiTtsConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly name = 'openai-tts';
  readonly availableVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: OpenAiTtsConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'tts-1';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; speed?: number },
  ): Promise<{ audio: Buffer; format: 'mp3' | 'opus' | 'wav' }> {
    const voice = opts?.voice ?? 'alloy';
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

    const buffer = Buffer.from(await res.arrayBuffer());
    return { audio: buffer, format: 'opus' };
  }
}
