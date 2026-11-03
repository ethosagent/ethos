import { z } from 'zod';

/** Roster-entry key. The parser in `@ethosagent/config` matches
 *  `voice.<tts|stt>.providers.([A-Za-z0-9_-]+).<field>`, so a name outside that
 *  charset would serialize to a line the loader silently drops. */
export const VoiceProviderNameRegex = /^[A-Za-z0-9_-]+$/;

/** One entry of the named TTS roster (`voice.tts.providers.<name>.*`). Same
 *  field set as the default `auxiliary.tts` entry, because it IS one — the entry
 *  a personality gets when it names no other. API key never round-trips. */
export const VoiceProviderEntryGetSchema = z.object({
  /** Registered provider id (`openai-tts`, `local-tts`, `command-tts`, …). */
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  voice: z.string().nullable(),
  baseUrl: z.string().nullable(),
  command: z.string().nullable(),
  outputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).nullable(),
  /** `voice.tts.providers.<name>.timeout` — seconds, `command-tts`'s unit. */
  timeout: z.number().nullable(),
  maxTextLength: z.number().nullable(),
});
/** Write shape for one roster entry. Omitting `apiKey` KEEPS the stored key —
 *  the form never receives it, so an absent field cannot mean "clear it". */
export const VoiceProviderEntryUpdateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  /** Write-only; never echoed back. Omit to keep the stored key. */
  apiKey: z.string().optional(),
  voice: z.string().optional(),
  baseUrl: z.string().optional(),
  command: z.string().optional(),
  outputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).optional(),
  /** Seconds. */
  timeout: z.number().int().min(1).max(3600).optional(),
  maxTextLength: z.number().int().min(100).max(100_000).optional(),
});

/** One entry of the named STT roster (`voice.stt.providers.<name>.*`). The
 *  mirror of the TTS entry over the `auxiliary.asr` field set — no `voice`,
 *  `outputFormat` or `maxTextLength`, which only mean something when producing
 *  audio. API key never round-trips. */
export const VoiceSttProviderEntryGetSchema = z.object({
  /** Registered provider id (`openai-stt`, `local-stt`, `command-stt`, …). */
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
  command: z.string().nullable(),
  /** `voice.stt.providers.<name>.timeout` — seconds, `command-stt`'s unit. */
  timeout: z.number().nullable(),
});
export const VoiceSttProviderEntryUpdateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  /** Write-only; never echoed back. Omit to keep the stored key. */
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  command: z.string().optional(),
  /** Seconds. */
  timeout: z.number().int().min(1).max(3600).optional(),
});

/** One entry of the named REALTIME roster (`voice.realtime.providers.<name>.*`)
 *  — hosted speech-to-speech. No `command` or `timeout`: a realtime provider is
 *  a duplex session, not a request you shell out for. `costPerMinuteUsd` is the
 *  provider's published rate, which is what turns session minutes into the cost
 *  `voiceRealtimeSessionBudgetUsd` halts on. API key never round-trips. */
export const VoiceRealtimeProviderEntryGetSchema = z.object({
  /** Registered provider id (`openai-realtime`, `gemini-live`, …). */
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
  voice: z.string().nullable(),
  costPerMinuteUsd: z.number().nullable(),
});
export const VoiceRealtimeProviderEntryUpdateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  /** Write-only; never echoed back. Omit to keep the stored key. */
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  voice: z.string().optional(),
  /** USD per minute of audio. Fractional — 6 cents a minute is `0.06`. */
  costPerMinuteUsd: z.number().positive().max(100).optional(),
});

// -- Telephony (`voice.trunk` / `voice.livekit` / `voice.inbound` /
//    `voice.bargeIn` / `voice.bots`) ------------------------------------------
//
// Every one of these keys was previously reachable only by hand-editing
// config.yaml. A phone number is the surface strangers can dial, so its
// allowlist, its budget and the personality that answers it must be visible and
// editable where the operator already manages the deployment — a yaml-only
// telephony key is a guard nobody can see.
//
// Same closed sets the CLI parser enforces, restated as Zod so a bad value is
// refused at the RPC boundary instead of turning into a parse error the next
// time the agent loads its config.

export const VoiceTrunkProviderSchema = z.enum(['twilio', 'telnyx', 'generic', 'livekit']);
export const VoiceTrunkCodecSchema = z.enum(['opus', 'g711']);
export const VoiceInboundPrewarmSchema = z.enum(['allowlisted', 'none', 'all']);

/** One surface's barge-in thresholds, as stored. Every field independently
 *  nullable: an operator tunes the one knob a room is wrong about. */
export const VoiceBargeInTuningGetSchema = z.object({
  energyThreshold: z.number().nullable(),
  minSpeechMs: z.number().nullable(),
  silenceMs: z.number().nullable(),
});

/** The write side of one surface's thresholds. Bounds mirror the CLI parser,
 *  which REFUSES an out-of-range value rather than dropping it. */
export const VoiceBargeInTuningUpdateSchema = z.object({
  /** Input energy above which the caller counts as speaking, 0 < x <= 1. */
  energyThreshold: z.number().gt(0).max(1).optional(),
  /** Milliseconds of speech before a barge-in is believed. */
  minSpeechMs: z.number().int().min(1).optional(),
  /** Milliseconds of silence that end an utterance. */
  silenceMs: z.number().int().min(1).optional(),
});

/** One `voice.bots[]` entry as stored — the number → bot → personality map. */
export const VoiceBotGetSchema = z.object({
  /** `voice.bots.<n>.id`; null when the operator left it to the derived
   *  sha256-of-`match` default. */
  id: z.string().nullable(),
  /** E.164 number or room name (`*` wildcards allowed) this bot answers. */
  match: z.string(),
  bind: z.object({
    type: z.enum(['personality', 'team']),
    name: z.string(),
    /** `voice.bots.<n>.bind.allowSlashSwitch`; false when the key is absent. */
    allowSlashSwitch: z.boolean(),
  }),
});

export const VoiceBotUpdateSchema = z.object({
  /** Omit to let the loader derive one from `match`. Must be an identifier
   *  (`[A-Za-z0-9_-]+`) — it becomes part of a config.yaml key. */
  id: z.string().optional(),
  match: z.string().min(1),
  bind: z.object({
    type: z.enum(['personality', 'team']),
    /** Validated against the personality registry when `type` is
     *  `personality` — a bot bound to a personality that does not exist fails
     *  silently on a ringing phone, and this is the last place to catch it. */
    name: z.string().min(1),
    allowSlashSwitch: z.boolean().optional(),
  }),
});
