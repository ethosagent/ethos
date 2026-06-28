// packages/types/src/voice.ts — voice provider contracts

export interface SttProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  transcribe(
    audioPath: string,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<string>;
}

export interface TtsProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  synthesize(
    text: string,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): Promise<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm' }>;
}

export interface VoiceCapabilities {
  kind: 'stt' | 'tts';
  formats: Array<'opus' | 'mp3' | 'wav' | 'pcm'>;
  languages?: string[];
  voices?: string[];
  streaming?: boolean;
  local?: boolean;
  maxInputChars?: number;
  contractVersion: number;
}

export interface VoiceProviderFactoryContext {
  config: Record<string, unknown>;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}

export type SttProviderFactory = (
  ctx: VoiceProviderFactoryContext,
) => SttProvider | Promise<SttProvider>;
export type TtsProviderFactory = (
  ctx: VoiceProviderFactoryContext,
) => TtsProvider | Promise<TtsProvider>;

export interface SttProviderRegistry {
  register(name: string, factory: SttProviderFactory): void;
  unregister(name: string): void;
  get(name: string): SttProviderFactory | undefined;
  list(): string[];
}

export interface TtsProviderRegistry {
  register(name: string, factory: TtsProviderFactory): void;
  unregister(name: string): void;
  get(name: string): TtsProviderFactory | undefined;
  list(): string[];
}
