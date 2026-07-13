import type {
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { transcribeOpenAiCompat } from './openai-compat';

// Local STT over an OpenAI-compatible endpoint (e.g. faster-whisper-server /
// Speaches serving Whisper large v3). API key is OPTIONAL — local servers
// usually need none. `model` is free-form and server-specific (e.g.
// `whisper-large-v3` or `Systran/faster-whisper-large-v3`).
export class LocalSttProvider implements SttProvider {
  readonly name = 'local-stt';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-large-v3';
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8000/v1';
    this.caps = {
      kind: 'stt',
      formats: ['opus', 'mp3', 'wav'],
      local: true,
      contractVersion: 1,
    };
  }

  async transcribe(audioPath: string): Promise<string> {
    return transcribeOpenAiCompat({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      audioPath,
      label: 'Local STT',
    });
  }
}

export function localSttFactory(ctx: VoiceProviderFactoryContext): LocalSttProvider {
  return new LocalSttProvider({
    apiKey: ctx.config.apiKey as string | undefined,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
  });
}
