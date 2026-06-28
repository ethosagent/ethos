import type {
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';

export class OpenAiSttProvider implements SttProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { name?: string; apiKey: string; model?: string; baseUrl?: string }) {
    this.name = opts.name ?? 'openai-stt';
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-1';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.caps = {
      kind: 'stt',
      formats: ['opus', 'mp3', 'wav'],
      local: false,
      contractVersion: 1,
    };
  }

  async transcribe(audioPath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(audioPath);
    const blob = new Blob([data]);
    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', this.model);

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI STT failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as { text: string };
    return json.text;
  }
}

export function openaiSttFactory(ctx: VoiceProviderFactoryContext): OpenAiSttProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('OpenAI STT requires apiKey');
  return new OpenAiSttProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
  });
}
