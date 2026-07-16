// Proactive memory capture (pillar B of the memory-experience plan, §3).
//
// The agent notices durable facts mid-conversation and records them — the
// "it remembered my daughter's name" moment — without waiting for nightly
// consolidation. Capture is the micro-loop: per-turn, append-only, cheap,
// add-only. It never destroys memory (a malformed extraction can add noise;
// consolidation later distills it).

/** A single durable fact extracted from a turn. */
export interface CaptureFact {
  /** Which file to append to. `add`-only — capture never replaces or removes. */
  store: 'memory' | 'user';
  /** The fact text (one line or short block), before content-safety sanitize. */
  text: string;
  /** Candidate importance in [0,1]; rides into the history entry's `hint`. */
  hint: number;
}

/**
 * What the `agent_done` hook handler enqueues. Deliberately small — everything
 * derivable (scopeId from personalityId, sessionKey from the SessionStore) is
 * resolved later in the queue worker, off the hot path.
 */
export interface CaptureJob {
  sessionId: string;
  personalityId: string;
  /** Final assistant text of the turn. */
  text: string;
  /** First user message of the turn. */
  initialPrompt: string;
  /**
   * True when the turn was a dry-run. The frozen `agent_done` payload does not
   * carry this, so wiring passes `false`; the eligibility guard still honours
   * it so the exclusion is correct if a signal is ever threaded through.
   */
  isDryRun: boolean;
}

/** Tuning knobs; every field has a default so wiring can pass a partial. */
export interface CaptureConfig {
  /** Skip turns whose user text is shorter than this. Default 80. */
  minUserChars: number;
  /** Max capture writes per scope per rolling hour. Default 6. */
  maxPerHour: number;
  /** Max capture writes per scope per rolling day. Default 30. */
  maxPerDay: number;
  /** Dedup lookback window in ms. Default 90 days. */
  dedupWindowMs: number;
  /** Inline-consolidation trigger: MEMORY.md byte size. Default 16 KiB. */
  consolidationSizeThreshold: number;
  /** Inline-consolidation trigger: captures since last consolidation. Default 50. */
  consolidationCountThreshold: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  minUserChars: 80,
  maxPerHour: 6,
  maxPerDay: 30,
  dedupWindowMs: 90 * 24 * 60 * 60 * 1000,
  consolidationSizeThreshold: 16 * 1024,
  consolidationCountThreshold: 50,
};

/** Payload for the `onCaptured` surface callback (§3.3). */
export interface CaptureNotice {
  scopeId: string;
  /** Human summary of what was remembered, e.g. `daughter Priya (b. 2019)`. */
  summary: string;
}
