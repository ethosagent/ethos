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

// ---------------------------------------------------------------------------
// Streaming voice contracts (additive — batch providers above remain valid).
//
// Real-time voice (see plan/phases/gap-voice-realtime.md §3(a)) drives audio
// as a live stream rather than a complete file. These interfaces extend the
// batch contracts above WITHOUT modifying them: a provider that advertises
// `caps.streaming === true` implements the streaming variant in addition to
// the batch method it inherits. Consumers feature-detect with the type
// guards below; batch-only providers keep working via utterance-buffered
// fallback in the caller.
// ---------------------------------------------------------------------------

/** A frame of linear PCM audio. `data` is signed 16-bit samples (mono). */
export interface PcmChunk {
  data: Int16Array;
  sampleRate: number;
  /** Optional capture timestamp (ms) for latency accounting. */
  timestampMs?: number;
}

/** An incremental transcription result from a streaming STT provider. */
export interface SttPartial {
  text: string;
  /** True once the provider considers this the settled transcript. */
  isFinal: boolean;
  confidence?: number;
}

/**
 * A streaming STT provider. Extends {@link SttProvider} additively: it still
 * carries the batch `transcribe()` method, and adds `transcribeStream()` for
 * live partial transcription. Advertise support via `caps.streaming === true`.
 */
export interface StreamingSttProvider extends SttProvider {
  transcribeStream(
    audio: AsyncIterable<PcmChunk>,
    opts?: { language?: string; signal?: AbortSignal },
  ): AsyncIterable<SttPartial>;
}

/**
 * A streaming TTS provider. Extends {@link TtsProvider} additively: it still
 * carries the batch `synthesize()` method, and adds `synthesizeStream()` that
 * consumes text as it is produced (e.g. per sentence) and yields audio chunks
 * as they are ready. Advertise support via `caps.streaming === true`.
 */
export interface StreamingTtsProvider extends TtsProvider {
  synthesizeStream(
    text: AsyncIterable<string>,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): AsyncIterable<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm' }>;
}

/** True when `p` implements the streaming STT contract. */
export function isStreamingSttProvider(p: SttProvider): p is StreamingSttProvider {
  return (
    p.caps.streaming === true && typeof (p as StreamingSttProvider).transcribeStream === 'function'
  );
}

/** True when `p` implements the streaming TTS contract. */
export function isStreamingTtsProvider(p: TtsProvider): p is StreamingTtsProvider {
  return (
    p.caps.streaming === true && typeof (p as StreamingTtsProvider).synthesizeStream === 'function'
  );
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
