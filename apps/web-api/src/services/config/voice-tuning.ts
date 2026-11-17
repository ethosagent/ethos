import type { VoiceBargeInTuning } from '@ethosagent/config';

// Voice VAD / barge-in tuning surfaced as flat `display.voice_*` passthrough
// keys. These defaults MUST stay byte-equal to `DEFAULT_VOICE_TUNING` in
// apps/web/src/features/voice/batch-voice-call-client.ts (the driver's single
// source of truth) — web-api can't import the browser bundle, so the values are
// duplicated here. `min`/`max` mirror the Zod bounds on ConfigUpdateInput; the
// service clamps to them so a direct (non-RPC) caller can't persist out-of-range.
type VoiceTuningField =
  | 'voiceEndpointSilenceMs'
  | 'voiceBargeThreshold'
  | 'voiceBargeSustainMs'
  | 'voiceSpeechThreshold'
  | 'voiceSpeechMinMs';
interface VoiceTuningSpec {
  field: VoiceTuningField;
  default: number;
  min: number;
  max: number;
}
export const VOICE_TUNING = {
  'display.voice_endpoint_silence_ms': {
    field: 'voiceEndpointSilenceMs',
    default: 700,
    min: 300,
    max: 1500,
  },
  'display.voice_barge_threshold': {
    field: 'voiceBargeThreshold',
    default: 0.06,
    min: 0.02,
    max: 0.2,
  },
  'display.voice_barge_sustain_ms': {
    field: 'voiceBargeSustainMs',
    default: 250,
    min: 100,
    max: 800,
  },
  'display.voice_speech_threshold': {
    field: 'voiceSpeechThreshold',
    default: 0.02,
    min: 0.005,
    max: 0.1,
  },
  'display.voice_speech_min_ms': { field: 'voiceSpeechMinMs', default: 150, min: 100, max: 500 },
} satisfies Record<string, VoiceTuningSpec>;

/** Resolve a stored `display.voice_*` value to a number, falling back to its
 *  default when unset or unparseable. */
export function readVoiceTuning(
  passthrough: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = passthrough[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `display.voice_*` → `VoiceBargeInTuning` compatibility read-through for the
 * BROWSER surface (Conflict 2, L1 — plan §7). `voice.bargeIn.browser` is the
 * modern knob; these flat keys predate it and must keep tuning calls until an
 * operator migrates. Unlike {@link readVoiceTuning}, this does NOT apply
 * `VOICE_TUNING`'s defaults — only a key the operator actually SET is
 * returned, so a deployment that never touched `display.voice_*` contributes
 * nothing here and the session keeps its own built-in defaults, exactly as it
 * did before `voice.bargeIn.browser` existed. The caller
 * (`buildVoiceStack`'s `createSession`) applies precedence: an explicit
 * `voice.bargeIn.browser` always wins over this fallback.
 *
 * Only three of the five `display.voice_*` knobs have a `VoiceBargeInTuning`
 * counterpart. `display.voice_speech_threshold` / `display.voice_speech_min_ms`
 * tuned the browser's own local endpointer, which the streaming pipeline lane
 * no longer has (`VoiceSession` owns VAD/endpointing now) — there is nothing
 * left for them to read into here.
 */
export function readLegacyBrowserBargeInTuning(
  passthrough: Record<string, string>,
): VoiceBargeInTuning {
  const read = (key: keyof typeof VOICE_TUNING): number | undefined => {
    const spec = VOICE_TUNING[key];
    const raw = passthrough[key];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, n));
  };
  const energyThreshold = read('display.voice_barge_threshold');
  const minSpeechMs = read('display.voice_barge_sustain_ms');
  const silenceMs = read('display.voice_endpoint_silence_ms');
  return {
    ...(energyThreshold !== undefined ? { energyThreshold } : {}),
    ...(minSpeechMs !== undefined ? { minSpeechMs } : {}),
    ...(silenceMs !== undefined ? { silenceMs } : {}),
  };
}
