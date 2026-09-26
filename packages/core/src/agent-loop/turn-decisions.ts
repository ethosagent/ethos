// Decision events in the turn stream (plan decision-provider-personality §15.3,
// PD16, PD17, PD20).
//
// Decision sites run in wiring (`runDecisionSite`, packages/wiring/src/
// decision-site.ts), behind three seams core already calls: the tier router,
// the injection classifier and the `before_tool_call` hook. Core hands each
// call a `DecisionSink` (the approver's through `ApproverDecisionSinks`, never
// the hook payload — ./approver-decision-sinks.ts) that stamps what core knows — the personality, the
// judged `toolCallId`, the turn's `traceId` — and queues what the site emits.
// `withDecisionEvents` yields the queue into the turn's event stream:
//
//   inner turn generator ──event──► drain queue, then the event   (drain-before)
//          │ awaiting (a site, the LLM, tools)
//          └── queue grows ──────► yield it now                   (PD20 race)
//   inner exhausted ─────────────► drain once more, then close    (tail, PD17)
//
// Order guarantees, each pinned by `__tests__/turn-decisions.test.ts`:
// - Events come out in the order sites emitted them, and never after an event
//   the inner generator yielded LATER than the emission: an approver row
//   precedes its `tool_start`, an injection row follows its `tool_end`.
// - The router runs before `run_start` exists, so its rows are HELD
//   (`hold`/`release` in turn-setup.ts) and come out right after `run_start`.
//   A consequence: the router's `started` (PD20) is not shown live — it
//   arrives with its `settled`. The router's budget is ≤ 500 ms.
// - A shadow result that settles after `done` is yielded in the tail while the
//   consumer still drains; one that settles after the iterator ends is dropped
//   from the stream (the site still records it to observability). Nothing ever
//   waits for a shadow result (R8).
//
// Persistence (§15.5, PD18): every `settled` event is also written to the
// session store (`SessionStore.appendDecision`, the store that holds the turn's
// messages) at the moment the site emits it — in-turn, in the post-`done` tail,
// AND after the iterator closed, so a row that never reached the live stream
// still appears on reload (K10). A write failure is swallowed: persistence
// never throws into a decision site or the turn.
//
// Zero cost for everyone else: the queue is ARMED only for a personality that
// names a decision provider and sets at least one site to something other than
// `off` (`declaresDecisionSites`). Unarmed, no sink is handed to any seam —
// so seam inputs are byte-identical to before — and the wrapper never races.
// That check is a cheap superset; `resolvePersonalityDecisionSite`
// (@ethosagent/config) stays the authority on whether a site runs.

import type { AgentEvent, DecisionSink, PersonalityConfig, SessionStore } from '@ethosagent/types';
import type { ApproverDecisionSinks } from './approver-decision-sinks';

type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

/** Whether this personality could run any decision site (a superset; see the file header). */
export function declaresDecisionSites(personality: PersonalityConfig): boolean {
  const decisions = personality.decisions;
  if (!decisions?.provider) return false;
  return Object.values(decisions.sites ?? {}).some((mode) => mode !== undefined && mode !== 'off');
}

export class TurnDecisions {
  private stamp: { personalityId: string; traceId?: string; sessionId?: string } | undefined;
  private readonly queue: DecisionEvent[] = [];
  private held = false;
  private closed = false;
  private wake: (() => void) | undefined;
  private signalPromise: Promise<null> | undefined;

  constructor(
    private readonly approverSinks?: ApproverDecisionSinks,
    /** Where `settled` rows are persisted (§15.5); absent or without
     *  `appendDecision` → nothing is written. */
    private readonly store?: SessionStore,
  ) {}

  /** Arms the queue for this turn when the personality declares decision sites. */
  arm(personality: PersonalityConfig, traceId: string | undefined, sessionId?: string): void {
    if (!declaresDecisionSites(personality)) return;
    this.stamp = {
      personalityId: personality.id,
      ...(traceId !== undefined ? { traceId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  /** The injected approver channel (./approver-decision-sinks.ts), if any. */
  get approverSinkDirectory(): ApproverDecisionSinks | undefined {
    return this.approverSinks;
  }

  get armed(): boolean {
    return this.stamp !== undefined && !this.closed;
  }

  /** A sink for one seam call, or `undefined` when unarmed (the seam then gets none). */
  sinkFor(toolCallId?: string): DecisionSink | undefined {
    const stamp = this.stamp;
    if (!stamp) return undefined;
    return {
      ...(stamp.traceId !== undefined ? { traceId: stamp.traceId } : {}),
      emit: (event) => {
        try {
          // Core's stamps replace whatever a site passed for them at runtime.
          const {
            personalityId: _p,
            toolCallId: _c,
            traceId: _t,
            ...body
          } = event as DecisionEvent;
          const stamped: DecisionEvent = {
            ...body,
            type: 'decision',
            personalityId: stamp.personalityId,
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            ...(stamp.traceId !== undefined ? { traceId: stamp.traceId } : {}),
          };
          // Persisted whether or not the stream is still open (file header).
          if (stamped.phase === 'settled') this.persist(stamp.sessionId, stamped);
          if (this.closed) return;
          this.queue.push(stamped);
          this.notify();
        } catch {
          // A sink never throws into a decision site.
        }
      },
    };
  }

  private persist(sessionId: string | undefined, event: DecisionEvent): void {
    if (sessionId === undefined || !this.store?.appendDecision) return;
    try {
      void this.store.appendDecision(sessionId, event).catch(() => {});
    } catch {
      // A store that throws synchronously is swallowed the same way.
    }
  }

  /** Keep queued events back until `release` (the router, before `run_start`). */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
    this.notify();
  }

  /** Queued events, oldest first. Empty while held, unless `force` (the tail). */
  take(force = false): DecisionEvent[] {
    if (this.queue.length === 0 || (this.held && !force)) return [];
    return this.queue.splice(0, this.queue.length);
  }

  /** Resolves (with `null`) once `take()` would return something. One shared promise per wait. */
  signal(): Promise<null> {
    if (this.queue.length > 0 && !this.held) return Promise.resolve(null);
    this.signalPromise ??= new Promise<null>((resolve) => {
      this.wake = () => resolve(null);
    });
    return this.signalPromise;
  }

  /** The turn's iterator ended: later emissions leave the stream. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.fire();
  }

  private notify(): void {
    if (this.queue.length > 0 && !this.held) this.fire();
  }

  private fire(): void {
    const wake = this.wake;
    this.wake = undefined;
    this.signalPromise = undefined;
    wake?.();
  }
}

/**
 * `{ bindApproverSink }` for one `before_tool_call` fire, or `{}` when the turn
 * is not armed or no approver channel was injected. The binding makes this
 * call's sink visible to the smart approver (and only through
 * `ApproverDecisionSinks.get`) until the returned release runs.
 */
export function approverSinkOf(
  decisions: TurnDecisions | undefined,
  sessionId: string,
  toolCallId: string,
): { bindApproverSink?: () => () => void } {
  const directory = decisions?.approverSinkDirectory;
  const sink = directory ? decisions?.sinkFor(toolCallId) : undefined;
  if (!directory || !sink) return {};
  return { bindApproverSink: () => directory.bind(sessionId, toolCallId, sink) };
}

type Settled = { r: IteratorResult<AgentEvent, unknown> } | { err: unknown };

/**
 * Yield `inner`'s events with the turn's decision events merged in (see the
 * file header). Drains `inner` exactly as a `yield*` would: it returns only
 * once `inner` is exhausted, and a consumer that stops early closes `inner`.
 */
export async function* withDecisionEvents(
  decisions: TurnDecisions,
  inner: AsyncGenerator<AgentEvent, unknown>,
): AsyncGenerator<AgentEvent> {
  let pending: Promise<Settled> | undefined;
  let finished = false;
  try {
    for (;;) {
      pending ??= inner.next().then(
        (r): Settled => ({ r }),
        (err: unknown): Settled => ({ err }),
      );
      const winner = decisions.armed
        ? await Promise.race([pending, decisions.signal()])
        : await pending;
      if (winner === null) {
        // PD20 — the inner turn is awaiting something (a site, the LLM, a
        // tool); show what the sites reported meanwhile.
        for (const event of decisions.take()) yield event;
        continue;
      }
      pending = undefined;
      if ('err' in winner) {
        finished = true;
        throw winner.err;
      }
      if (winner.r.done) {
        finished = true;
        break;
      }
      for (const event of decisions.take()) yield event;
      yield winner.r.value;
    }
    // Tail (PD17): whatever settled during the post-`done` maintenance, held or not.
    for (const event of decisions.take(true)) yield event;
  } finally {
    decisions.close();
    if (!finished) {
      if (pending) {
        // The inner turn is mid-await; close it at its next yield without
        // making the consumer wait for that.
        void inner.return(undefined).catch(() => {});
      } else {
        await inner.return(undefined);
      }
    }
  }
}
