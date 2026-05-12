// FW-11 — chat-surface spinner state machine.
//
// One braille glyph cycling at 100ms, tinted with the active personality
// accent. Starts on the `before_llm_call` hook (or equivalent: the start of
// the agent turn before any `text_delta`); stops on the first `text_delta`
// or `done`. `prefers-reduced-motion` (or `--no-spinner-animation`) replaces
// the cycle with a static `·`; the elapsed counter still updates.

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const STATIC_GLYPH = '·';

export type SpinnerPhase = 'idle' | 'running' | 'stopped';

export interface SpinnerOptions {
  /** Substitute a static `·` for the cycling glyph. Default false. */
  reducedMotion?: boolean;
  /** Tick cadence in ms. Default 100. */
  tickMs?: number;
}

/**
 * Pure state machine — no I/O. The REPL drives `tick()` from a setInterval,
 * calls `stop()` on the first `text_delta`/`done`, and renders `frame()`
 * + `elapsed()` together.
 *
 * Lifecycle:
 *   start()      → phase = 'running', frameIdx = 0, elapsedMs = 0
 *   tick(now)    → advance frame, update elapsedMs from `now`
 *   stop(now)    → phase = 'stopped'; record final elapsed
 *   frame()      → current frame glyph (static · when reducedMotion)
 *   elapsed()    → "1.2s" / "1m 23s"
 *
 * `start()` re-starts a stopped instance — used between turns.
 */
export class SpinnerState {
  private phase: SpinnerPhase = 'idle';
  private startedAt = 0;
  private elapsedMs = 0;
  private frameIdx = 0;
  private readonly reducedMotion: boolean;

  constructor(options: SpinnerOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false;
  }

  start(now: number): void {
    this.phase = 'running';
    this.startedAt = now;
    this.elapsedMs = 0;
    this.frameIdx = 0;
  }

  tick(now: number): void {
    if (this.phase !== 'running') return;
    this.elapsedMs = now - this.startedAt;
    this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
  }

  stop(now: number): void {
    if (this.phase !== 'running') {
      // stop() called on idle/stopped instance — leave elapsedMs untouched.
      this.phase = 'stopped';
      return;
    }
    this.elapsedMs = now - this.startedAt;
    this.phase = 'stopped';
  }

  isRunning(): boolean {
    return this.phase === 'running';
  }

  getPhase(): SpinnerPhase {
    return this.phase;
  }

  frame(): string {
    if (this.reducedMotion) return STATIC_GLYPH;
    return SPINNER_FRAMES[this.frameIdx] ?? SPINNER_FRAMES[0];
  }

  elapsed(): string {
    return formatElapsed(this.elapsedMs);
  }

  elapsedMillis(): number {
    return this.elapsedMs;
  }
}

export function formatElapsed(ms: number): string {
  const totalSecs = ms / 1000;
  if (totalSecs < 60) return `${totalSecs.toFixed(1)}s`;
  const mins = Math.floor(totalSecs / 60);
  const remSecs = Math.floor(totalSecs - mins * 60);
  return `${mins}m ${remSecs}s`;
}
