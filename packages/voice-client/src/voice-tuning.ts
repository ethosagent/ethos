/**
 * Live-tunable VAD / barge-in parameters for local endpointing. Every field is
 * a raw driver constant surfaced to the user (Settings → Voice → Advanced voice
 * tuning) so endpointing and interrupt behavior can be adjusted without editing
 * code.
 */
export interface VoiceTuning {
  /** Trailing silence (ms) that ends an utterance. */
  endpointSilenceMs: number;
  /** RMS bar during agent playout before a barge-in can fire (echo tolerance). */
  bargeThreshold: number;
  /** Sustained speech (ms) over playout before barge-in fires. */
  bargeSustainMs: number;
  /** RMS to count as speech while listening. */
  speechThreshold: number;
  /** Minimum speech (ms) before an utterance counts. */
  speechMinMs: number;
}

/**
 * The single source of truth for the local VAD / barge-in defaults. The web
 * batch driver and `PcmEndpointer` fall back to these per-field, and Settings
 * imports them so the UI defaults never drift from the driver. The web-api
 * ConfigService keeps a byte-equal copy (it cannot import this package) — see
 * `VOICE_TUNING_DEFAULTS` there.
 */
export const DEFAULT_VOICE_TUNING: VoiceTuning = {
  endpointSilenceMs: 700,
  bargeThreshold: 0.06,
  bargeSustainMs: 250,
  speechThreshold: 0.02,
  speechMinMs: 150,
};
