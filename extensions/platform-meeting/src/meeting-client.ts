// MeetingClient — the isolated boundary that keeps the concrete Playwright +
// browser-automation stack out of this repo's dependency graph (meeting-join
// half of Phase D, plan/phases/gap-voice-realtime.md §3(d)/§4).
//
// A Google Meet transcribe-only join is browser automation: a headless Chromium
// (Playwright, reusing the existing `tools-browser` surface) opens the meeting
// URL as a bot participant, enables live captions, and SCRAPES the caption
// container — NOT audio processing (this is exactly how Hermes' google_meet
// plugin works, plan §2). Meet renders captions as rolling, in-place updates:
// each speaker's line grows/gets corrected until they pause, then finalizes.
//
// The production binding wraps Playwright driving a real Chromium against a live
// Meet. NEITHER Playwright nor a browser is installed in-repo: a headful browser
// join cannot be verified here without a running meeting, so committing it would
// put an unverifiable, flaky dependency in the monorepo. Instead everything
// binds ONLY to the interface below, so it typechecks and unit-tests against a
// `FakeMeetingClient` + a recorded caption fixture; wiring the real binding is a
// documented MANUAL step (see README.md "Manual verification checklist").

/** Options for joining a Google Meet as the transcribe-only bot participant. */
export interface MeetingJoinOptions {
  /** Google Meet URL, e.g. `https://meet.google.com/abc-defg-hij`. */
  url: string;
  /** Display name the bot participant shows in the meeting roster. */
  displayName: string;
}

/**
 * One raw caption fragment as scraped from the Meet caption container. Meet
 * emits the FULL current text of an active caption line on every update (a
 * rolling replace, not a delta): "So" -> "So I" -> "So I think we should ship".
 * Consecutive fragments sharing a `blockId` are updates to the SAME utterance;
 * a new `blockId` (or, absent ids, a speaker change) marks the previous line
 * finalized. The {@link import('./caption-parser').CaptionParser} turns this
 * noisy stream into clean transcript entries.
 */
export interface RawCaptionFragment {
  /** Scraped speaker name. Empty string when Meet has not attributed the line. */
  speaker: string;
  /** Full current caption text for this line (rolling, last-wins per block). */
  text: string;
  /**
   * Stable id of the caption DOM line while it stays active, when scrapable.
   * Groups rolling updates of one utterance; a new id finalizes the prior one.
   * Absent when the DOM exposes no stable id — the parser falls back to
   * contiguous same-speaker runs.
   */
  blockId?: string;
}

/**
 * Minimal meeting client — ONLY the surface Phase D uses. Transcribe-only: there
 * is deliberately NO speak/say method (`meet_say` is deferred, plan §3(d)/§4).
 * One client = one meeting join.
 */
export interface MeetingClient {
  /** Join the meeting and enable captions. Resolves once captions can flow. */
  join(opts: MeetingJoinOptions): Promise<void>;
  /**
   * Subscribe to raw scraped caption fragments. The handler receives one
   * {@link RawCaptionFragment} per scraped update. Returns an unsubscribe fn.
   * Subscribe BEFORE {@link join} so no early captions are missed.
   */
  onCaption(handler: (fragment: RawCaptionFragment) => void): () => void;
  /** Leave the meeting and release the browser session. */
  leave(): Promise<void>;
}
