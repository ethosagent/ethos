/** Redacted view of one auxiliary model slot (`auxiliary.<slot>.*`). */
export interface AuxModelGetResult {
  model: string | null;
  provider: string | null;
  apiKeyPreview: string | null;
  baseUrl: string | null;
}

/** Update shape for an auxiliary model slot; null clears the stored key. */
export interface AuxModelUpdateInput {
  model?: string | null;
  provider?: string | null;
  /** Write-only; never echoed back. */
  apiKey?: string | null;
  baseUrl?: string | null;
}

/** One inbound webhook (`webhooks.<hookId>.*`) with the secret redacted. */
export interface WebhookGetResult {
  personalityId: string;
  secretPreview: string;
  sessionKey: string | null;
  prefilter: string | null;
  prefilterTimeoutSeconds: number | null;
  mode: 'sync' | 'ack';
}

/** Update shape for one webhook. `secret` is write-only: omitted keeps the
 *  stored secret; a brand-new hook without one gets a generated secret. */
export interface WebhookUpdateInput {
  personalityId: string;
  secret?: string;
  sessionKey?: string;
  prefilter?: string;
  prefilterTimeoutSeconds?: number;
  mode?: 'sync' | 'ack';
}

/** One `/name` quick command (`quick_commands.<name>.*`). */
export type QuickCommandGetResult =
  | { type: 'exec'; command: string; gateway: boolean; channels: string[] }
  | { type: 'reply'; reply: string; gateway: boolean; channels: string[] };

export type QuickCommandUpdateInput =
  | { type: 'exec'; command: string; gateway?: boolean; channels?: string[] }
  | { type: 'reply'; reply: string; gateway?: boolean; channels?: string[] };

/** One entry of the named TTS roster (`voice.tts.providers.<name>.*`), API key
 *  redacted to a preview exactly like `auxiliary.tts.apiKey`. */
export interface VoiceProviderGetResult {
  provider: string;
  model: string | null;
  apiKeyPreview: string | null;
  voice: string | null;
  baseUrl: string | null;
  command: string | null;
  outputFormat: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  /** Seconds — the unit `command-tts` reads. */
  timeout: number | null;
  maxTextLength: number | null;
}

/** Update shape for one TTS roster entry. `apiKey` is write-only: the form never
 *  receives it, so an omitted field KEEPS the stored key rather than clearing
 *  it (same rule as `webhooks.<id>.secret`). */
export interface VoiceProviderUpdateInput {
  provider: string;
  model?: string;
  apiKey?: string;
  voice?: string;
  baseUrl?: string;
  command?: string;
  outputFormat?: 'opus' | 'mp3' | 'wav' | 'pcm';
  timeout?: number;
  maxTextLength?: number;
}

/** One entry of the named STT roster (`voice.stt.providers.<name>.*`). The
 *  mirror of {@link VoiceProviderGetResult} over the STT field set. */
export interface VoiceSttProviderGetResult {
  provider: string;
  model: string | null;
  apiKeyPreview: string | null;
  baseUrl: string | null;
  command: string | null;
  /** Seconds — the unit `command-stt` reads. */
  timeout: number | null;
}

/** Update shape for one STT roster entry. Same write-only `apiKey` rule. */
export interface VoiceSttProviderUpdateInput {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  command?: string;
  timeout?: number;
}

/** One entry of the named realtime roster (`voice.realtime.providers.<name>.*`).
 *  The speech-to-speech sibling of the two above — no command or timeout,
 *  because there is no shelled-out request to bound; instead a per-minute rate,
 *  which is what a duplex session is billed on. */
export interface VoiceRealtimeProviderGetResult {
  provider: string;
  model: string | null;
  apiKeyPreview: string | null;
  baseUrl: string | null;
  voice: string | null;
  /** USD per minute of audio. */
  costPerMinuteUsd: number | null;
}

/** Update shape for one realtime roster entry. Same write-only `apiKey` rule. */
export interface VoiceRealtimeProviderUpdateInput {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  voice?: string;
  costPerMinuteUsd?: number;
}

export interface VoiceBargeInTuningResult {
  energyThreshold: number | null;
  minSpeechMs: number | null;
  silenceMs: number | null;
}

export interface VoiceBargeInTuningUpdate {
  energyThreshold?: number;
  minSpeechMs?: number;
  silenceMs?: number;
}

export interface VoiceFillerGetResult {
  enabled: boolean;
  afterMs: number | null;
  text: string | null;
  tickIntervalMs: number | null;
}

export interface VoiceFillerUpdate {
  enabled?: boolean | null;
  afterMs?: number | null;
  text?: string | null;
  tickIntervalMs?: number | null;
}

export interface VoiceBotGetResult {
  id: string | null;
  match: string;
  bind: { type: 'personality' | 'team'; name: string; allowSlashSwitch: boolean };
}

export interface VoiceBotUpdateInput {
  id?: string;
  match: string;
  bind: { type: 'personality' | 'team'; name: string; allowSlashSwitch?: boolean };
}
