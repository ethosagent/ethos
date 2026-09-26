// ---------------------------------------------------------------------------
// Silent-lane liveness — H1 + H2 (plan/phases/ux-feedback-and-config-clarity.md §4)
//
// H1: a lane whose reply does not stream gets NOTHING between the inbound and
// the final send. After `slowTurnNoticeMs` of silence with no text_delta, the
// lane gets ONE untracked "_working on it · <tool|thinking>…_" ack.
//
// H2: a tool call that runs `toolNoticeMs` (10 s) with no user-audience
// progress of its own gets a "working on it (<tool>)…" line. On a streaming
// lane that line goes to the draft's single italic progress line, edited in
// place (design rule 3 — never a new message per event). On a non-streaming
// lane it shares H1's once-per-turn latch (`noticeSent`), so H1 and H2
// together produce AT MOST ONE message per lane per turn (§9 — one shared
// latch; Hermes #101209 is the flood to avoid). `slowTurnNoticeMs: 0`
// disables the whole non-streaming notice family — the latch and both timers
// behind it — because the knob is "may this lane get an unprompted ack at
// all", not only "when does the first one fire". Streaming lanes keep the H2
// progress-line fallback regardless: an edit of the existing draft is not a
// new message.
//
// The caller decides which lanes participate: email lanes never get the
// notice (UD9 — a second email is worse than silence) and review turns are
// not user-facing turns, so `runTurn` simply constructs no TurnFeedback for
// them. Pinned by `__tests__/slow-turn-notice.test.ts` and
// `__tests__/tool-activity-line.test.ts`.
// ---------------------------------------------------------------------------

import { shouldSurfaceProgress } from '@ethosagent/surface-kit';
import type { AgentEvent } from '@ethosagent/types';

/** H2 — how long a tool call may run silently before its activity line. */
export const TOOL_ACTIVITY_NOTICE_MS = 10_000;

export interface TurnFeedbackOptions {
  /**
   * H1 delay. `0` (or negative) disables every non-streaming notice this
   * class can send — H1's turn timer and H2's shared-latch fallback alike.
   */
  slowTurnNoticeMs: number;
  /** Streaming lane: H2 pushes here (the draft's italic progress line). */
  pushProgress?: (text: string) => void;
  /** Non-streaming lane: the one untracked per-turn ack goes here. */
  sendNotice?: (text: string) => void;
  /** H2 delay override, for tests. */
  toolNoticeMs?: number;
}

/**
 * Per-turn feedback timers. Construct one per `runTurn`, call `start()` at
 * turn start, feed it every AgentEvent, and `dispose()` at the terminal event
 * (and again in the turn's `finally` — dispose is idempotent).
 */
export class TurnFeedback {
  private readonly slowTurnNoticeMs: number;
  private readonly toolNoticeMs: number;
  private readonly pushProgress: ((text: string) => void) | undefined;
  private readonly sendNotice: ((text: string) => void) | undefined;

  /** §9 — the one shared once-per-turn latch for non-streaming notices. */
  private noticeSent = false;
  /** First text_delta arrived — the reply is being composed; H1 stands down. */
  private textSeen = false;
  private disposed = false;
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  /** Running non-internal tool calls, insertion-ordered: callId → toolName. */
  private readonly runningTools = new Map<string, string>();
  /** H2 per-call silence timers, keyed by toolCallId. */
  private readonly toolTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tools whose own user-audience progress already arrived this turn. */
  private readonly progressSeen = new Set<string>();

  constructor(options: TurnFeedbackOptions) {
    this.slowTurnNoticeMs = options.slowTurnNoticeMs;
    this.toolNoticeMs = options.toolNoticeMs ?? TOOL_ACTIVITY_NOTICE_MS;
    this.pushProgress = options.pushProgress;
    this.sendNotice = options.sendNotice;
  }

  /** Arm H1's turn timer. No-op on streaming lanes and when disabled. */
  start(): void {
    if (!this.sendNotice || this.slowTurnNoticeMs <= 0 || this.disposed) return;
    this.turnTimer = setTimeout(() => {
      this.maybeSendTurnNotice(this.currentToolName() ?? 'thinking');
    }, this.slowTurnNoticeMs);
  }

  onEvent(event: AgentEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'text_delta':
        // The model is composing the answer — cancel H1 rather than talk over
        // the reply that is about to land ("cancelled by early text").
        this.textSeen = true;
        this.clearTurnTimer();
        break;
      case 'tool_start': {
        // Internal calls (an inner script call, `_`-prefixed loop pseudo-tools)
        // are not user-visible activity and never earn a notice.
        if (event.audience === 'internal' || event.toolName.startsWith('_')) break;
        this.runningTools.set(event.toolCallId, event.toolName);
        const callId = event.toolCallId;
        const toolName = event.toolName;
        this.toolTimers.set(
          callId,
          setTimeout(() => {
            this.toolTimers.delete(callId);
            this.fireToolNotice(toolName);
          }, this.toolNoticeMs),
        );
        break;
      }
      case 'tool_end': {
        const timer = this.toolTimers.get(event.toolCallId);
        if (timer) {
          clearTimeout(timer);
          this.toolTimers.delete(event.toolCallId);
        }
        this.runningTools.delete(event.toolCallId);
        break;
      }
      case 'tool_progress':
        // The tool spoke for itself (and on a streaming lane the streamer
        // already showed it) — its own H2 timer stands down.
        if (shouldSurfaceProgress(event)) this.progressSeen.add(event.toolName);
        break;
      default:
        break;
    }
  }

  /** Idempotent. Clears every pending timer; nothing fires afterwards. */
  dispose(): void {
    this.disposed = true;
    this.clearTurnTimer();
    for (const timer of this.toolTimers.values()) clearTimeout(timer);
    this.toolTimers.clear();
  }

  private currentToolName(): string | undefined {
    let last: string | undefined;
    for (const name of this.runningTools.values()) last = name;
    return last;
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = undefined;
    }
  }

  private fireToolNotice(toolName: string): void {
    if (this.disposed || this.progressSeen.has(toolName)) return;
    if (this.pushProgress) {
      // Streaming lane: one italic line, edited in place, replaced by the
      // next text edit. Not latched — an edit is not a new message.
      this.pushProgress(`working on it (${toolName})…`);
      return;
    }
    this.maybeSendTurnNotice(toolName);
  }

  /** The non-streaming send, behind the shared latch. */
  private maybeSendTurnNotice(label: string): void {
    if (!this.sendNotice || this.slowTurnNoticeMs <= 0) return;
    if (this.disposed || this.noticeSent || this.textSeen) return;
    this.noticeSent = true;
    this.clearTurnTimer();
    this.sendNotice(`_working on it · ${label}…_`);
  }
}
