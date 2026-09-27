import type { VoiceTier } from '../bar';

// Call trace recorder — the measurement half of the phone voice bar.
//
// A call appends typed events as they happen; `toJsonl()` serialises them one
// JSON object per line, and `analyze.ts` grades that file against
// `PHONE_VOICE_BAR`. Both clocks are injected so the recorder is deterministic
// in tests and the same code runs in the browser and on the phone:
//
// - `now()` — a MONOTONIC millisecond clock (`performance.now()`). Every event's
//   `t` is on this clock.
// - `audioNow()` — the audio output clock in SECONDS (`AudioContext.currentTime`
//   or the native equivalent). `sched` records it beside `t` so the analyser can
//   map a scheduled `startAt` (audio seconds) onto the monotonic clock:
//   `t + (startAt - ctxNow) * 1000`.
//
// Cheap enough to leave on in dev builds: an append is one small object push —
// no serialisation, no I/O — until someone asks for the JSONL. `maxEvents`
// bounds memory on a long call; past it, events are counted, not stored.

export type TraceLinkStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type CallTraceEvent =
  | { ev: 'header'; v: 1; tier: VoiceTier; label?: string }
  | { ev: 'mic_frame'; t: number; rms: number; n: number }
  | { ev: 'local_onset'; t: number }
  | { ev: 'local_end'; t: number }
  | { ev: 'tx_audio'; t: number; seq: number }
  | {
      ev: 'rx';
      t: number;
      frame: string;
      utteranceId?: string;
      segmentId?: string;
      seq?: number;
    }
  | { ev: 'sched'; t: number; ctxNow: number; startAt: number; dur: number; utteranceId: string }
  | { ev: 'underrun'; t: number; gapMs: number }
  | { ev: 'stop'; t: number; reason: string }
  | { ev: 'link'; t: number; status: TraceLinkStatus }
  | { ev: 'interruption'; t: number; phase: 'began' | 'ended' }
  | { ev: 'engine_error'; t: number; code: string; message: string }
  | { ev: 'calib'; roundTripMs: number };

export interface CallTraceClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Audio output clock, seconds. Absent: `sched` start times are monotonic seconds. */
  audioNow?(): number;
}

export interface CallTraceOptions {
  tier: VoiceTier;
  clock: CallTraceClock;
  /** Free-form run label written into the header (device, build, network). */
  label?: string;
  /** Stop storing after this many events (default 200 000 ≈ an hour of 20 ms frames). */
  maxEvents?: number;
}

export interface CallTrace {
  micFrame(rms: number, n: number): void;
  localOnset(): void;
  localEnd(): void;
  txAudio(seq: number): void;
  rx(frame: string, ids?: { utteranceId?: string; segmentId?: string; seq?: number }): void;
  /** `startAt`/`dur` in audio-clock seconds. */
  sched(startAt: number, dur: number, utteranceId: string): void;
  underrun(gapMs: number): void;
  stop(reason: string): void;
  link(status: TraceLinkStatus): void;
  interruption(phase: 'began' | 'ended'): void;
  /** The audio engine reported a failure (a clip it could not decode, a
   *  session it could not resume). `code` is the engine's, `message` free-form. */
  engineError(code: string, message: string): void;
  calib(roundTripMs: number): void;
  events(): readonly CallTraceEvent[];
  /** Events not stored because `maxEvents` was reached. */
  dropped(): number;
  toJsonl(): string;
}

const DEFAULT_MAX_EVENTS = 200_000;

export function createCallTrace(options: CallTraceOptions): CallTrace {
  const { clock } = options;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const log: CallTraceEvent[] = [
    {
      ev: 'header',
      v: 1,
      tier: options.tier,
      ...(options.label !== undefined ? { label: options.label } : {}),
    },
  ];
  let droppedCount = 0;
  const push = (event: CallTraceEvent): void => {
    if (log.length >= maxEvents) {
      droppedCount++;
      return;
    }
    log.push(event);
  };

  return {
    micFrame: (rms, n) => push({ ev: 'mic_frame', t: clock.now(), rms, n }),
    localOnset: () => push({ ev: 'local_onset', t: clock.now() }),
    localEnd: () => push({ ev: 'local_end', t: clock.now() }),
    txAudio: (seq) => push({ ev: 'tx_audio', t: clock.now(), seq }),
    rx: (frame, ids) => push({ ev: 'rx', t: clock.now(), frame, ...ids }),
    sched: (startAt, dur, utteranceId) => {
      const t = clock.now();
      // No audio clock: `startAt` is taken to be on the monotonic clock, in seconds.
      const ctxNow = clock.audioNow ? clock.audioNow() : t / 1000;
      push({ ev: 'sched', t, ctxNow, startAt, dur, utteranceId });
    },
    underrun: (gapMs) => push({ ev: 'underrun', t: clock.now(), gapMs }),
    stop: (reason) => push({ ev: 'stop', t: clock.now(), reason }),
    link: (status) => push({ ev: 'link', t: clock.now(), status }),
    interruption: (phase) => push({ ev: 'interruption', t: clock.now(), phase }),
    engineError: (code, message) => push({ ev: 'engine_error', t: clock.now(), code, message }),
    calib: (roundTripMs) => push({ ev: 'calib', roundTripMs }),
    events: () => log,
    dropped: () => droppedCount,
    toJsonl: () => `${log.map((event) => JSON.stringify(event)).join('\n')}\n`,
  };
}
