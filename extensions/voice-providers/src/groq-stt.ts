import type {
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';

export class GroqSttProvider implements SttProvider {
  readonly name = 'groq-stt';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-large-v3';
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

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq STT failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as { text: string };
    return json.text;
  }
}

export function groqSttFactory(ctx: VoiceProviderFactoryContext): GroqSttProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('Groq STT requires apiKey');
  return new GroqSttProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
  });
}
