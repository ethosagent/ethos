import { DEFAULT_VOICE_TUNING } from './voice-tuning';

// Local barge-in: stop the agent's playout the moment the user talks over it,
// on the device, without waiting for a server round trip.
//
// The rule: while playout is speaking, an RMS onset above `threshold` that
// stays above it for `sustainMs` fires ONCE — `stop()` the playout, report the
// event — and further triggers are suppressed until playout has gone quiet.
// Nothing fires while playout is not speaking; the user is simply talking then.
//
// REQUIRES ECHO CANCELLATION on the capture path (the platform's voice-processing
// I/O). Without it the mic hears the agent's own speaker output, crosses the
// threshold, and the agent interrupts itself. `threshold` is an echo tolerance,
// not a substitute for AEC.
//
// Time comes from the injected clock (or a per-frame timestamp), so the whole
// rule is testable without audio.

/** The slice of a playout this needs. */
export interface BargeInPlayout {
  speaking(): boolean;
  stop(): void;
}

export interface LocalBargeInEvent {
  /** When the trigger fired (clock ms). */
  t: number;
  /** When the sustained run began (clock ms). */
  onsetAt: number;
  /** RMS of the frame that fired it. */
  rms: number;
}

export interface LocalBargeInOptions {
  playout: BargeInPlayout;
  /** Monotonic ms. */
  now: () => number;
  /** RMS a frame must exceed to count as speech over playout. Default: the shared `bargeThreshold`. */
  threshold?: number;
  /** How long the onset must be sustained before firing. Default 100 ms. */
  sustainMs?: number;
  onBargeIn?: (event: LocalBargeInEvent) => void;
}

export interface LocalBargeIn {
  /** Feed one mic frame's RMS. `t` defaults to `now()`. True when it fired. */
  frame(rms: number, t?: number): boolean;
  /** Forget any run in progress and re-arm. */
  reset(): void;
}

export const DEFAULT_LOCAL_BARGE_SUSTAIN_MS = 100;

export function createLocalBargeIn(opts: LocalBargeInOptions): LocalBargeIn {
  const threshold = opts.threshold ?? DEFAULT_VOICE_TUNING.bargeThreshold;
  const sustainMs = opts.sustainMs ?? DEFAULT_LOCAL_BARGE_SUSTAIN_MS;
  let onsetAt: number | null = null;
  let armed = true;

  return {
    frame(rms: number, t: number = opts.now()): boolean {
      if (!opts.playout.speaking()) {
        // Quiet playout re-arms; there is nothing to interrupt.
        onsetAt = null;
        armed = true;
        return false;
      }
      if (!armed) return false;
      if (rms <= threshold) {
        onsetAt = null;
        return false;
      }
      if (onsetAt === null) onsetAt = t;
      if (t - onsetAt < sustainMs) return false;
      armed = false;
      const event: LocalBargeInEvent = { t, onsetAt, rms };
      onsetAt = null;
      opts.playout.stop();
      opts.onBargeIn?.(event);
      return true;
    },

    reset(): void {
      onsetAt = null;
      armed = true;
    },
  };
}
