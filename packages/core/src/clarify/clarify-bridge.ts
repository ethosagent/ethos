// ClarifyBridge — the runtime mechanism behind the `clarify` tool.
//
// The `clarify` tool calls `request()`, which persists a pending row, presents
// it to the active surface, and returns a promise that resolves when the user
// answers (`respond()`), the timeout fires, or the turn is aborted. A surface
// (TUI / CLI / web-api) registers a `presenter` and calls `respond()` when the
// user replies. This mirrors the tool-call approval transport — the agent is
// paused by the blocked tool, not by interleaving events into the stream.
//
// See plan/phases/tool_clarity_plan.md.

import { randomUUID } from 'node:crypto';
import type {
  ClarifyAnswerableBy,
  ClarifyResponse,
  ClarifyStore,
  ClarifySurfaceType,
  PendingClarify,
} from '@ethosagent/types';

/** Raised by `request()` when a clarify is already pending for the session (plan Q5). */
export class ClarifyBusyError extends Error {
  readonly code = 'CLARIFY_BUSY' as const;
  constructor() {
    super('Another clarify is already pending for this session');
    this.name = 'ClarifyBusyError';
  }
}

/** Raised by `request()` when the timeout fires and no `default` was provided (plan Q4/C). */
export class ClarifyTimedOutNoDefaultError extends Error {
  readonly code = 'CLARIFY_TIMED_OUT_NO_DEFAULT' as const;
  constructor() {
    super('Clarify timed out and no default was provided');
    this.name = 'ClarifyTimedOutNoDefaultError';
  }
}

/** Raised by `request()` when no interactive surface has registered a presenter. */
export class ClarifyNoSurfaceError extends Error {
  readonly code = 'CLARIFY_NO_SURFACE' as const;
  constructor() {
    super('No interactive surface is available to present the clarify request');
    this.name = 'ClarifyNoSurfaceError';
  }
}

export interface ClarifyRequestInput {
  question: string;
  options?: string[];
  default?: string;
  timeoutMs: number;
  answerableBy: ClarifyAnswerableBy;
  sessionId: string;
  surfaceType: ClarifySurfaceType;
  surfaceContext?: Record<string, unknown>;
  /** When the turn aborts, the pending clarify resolves as cancelled. */
  abortSignal?: AbortSignal;
}

/** A surface registers this to present a pending clarify to the user. */
export type ClarifyPresenter = (req: PendingClarify) => void | Promise<void>;

/**
 * Fired when a pending clarify resolves (user answer, timeout, or cancel) —
 * surfaces use it to tear down the prompt/modal/card they presented. The
 * `row` carries the session id and request id; `response` is `null` for the
 * timeout-no-default case (no answer was produced).
 */
export type ClarifyResolvedListener = (
  row: PendingClarify,
  response: ClarifyResponse | null,
) => void;

interface PendingEntry {
  row: PendingClarify;
  resolve: (r: ClarifyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ClarifyBridge {
  private readonly pending = new Map<string, PendingEntry>();
  private presenter: ClarifyPresenter | undefined;
  private readonly resolvedListeners = new Set<ClarifyResolvedListener>();

  /**
   * `store` is exposed read-only so a surface (e.g. TelegramClarifySurface)
   * can patch `surfaceContext` after presenting the prompt and look up rows
   * by id without proxying every call through the bridge.
   */
  constructor(public readonly store: ClarifyStore) {}

  /** A surface registers how it presents a pending clarify to the user. */
  setPresenter(presenter: ClarifyPresenter): void {
    this.presenter = presenter;
  }

  /**
   * Subscribe to clarify resolutions so a surface can tear down its prompt
   * when the request is answered, times out, or is cancelled. Returns an
   * unsubscribe function.
   */
  onResolved(listener: ClarifyResolvedListener): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  /** True iff a clarify is currently pending for the given session. */
  hasPending(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.row.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Pending rows still awaiting an answer — for SSE reconnect re-presentation. */
  listPending(sessionId?: string): PendingClarify[] {
    const rows: PendingClarify[] = [];
    for (const entry of this.pending.values()) {
      if (sessionId === undefined || entry.row.sessionId === sessionId) rows.push(entry.row);
    }
    return rows;
  }

  /**
   * Persisted pending rows from the store — for boot-time hydration (a surface
   * that outlives a single process needs to find rows that survived a
   * restart). `listPending()` only sees in-memory rows; this is the source of
   * truth across restarts.
   */
  async listPersisted(filter?: {
    surfaceType?: string;
    sessionId?: string;
  }): Promise<PendingClarify[]> {
    return this.store.list(filter);
  }

  /**
   * Issue a clarify request. Resolves when the user answers, the timeout fires
   * (with `default`), or the turn aborts (as cancelled). Rejects with
   * `ClarifyBusyError` if one is already pending for the session, or with
   * `ClarifyTimedOutNoDefaultError` on timeout when no `default` was given.
   */
  async request(input: ClarifyRequestInput): Promise<ClarifyResponse> {
    if (!this.presenter) throw new ClarifyNoSurfaceError();
    if (this.hasPending(input.sessionId)) throw new ClarifyBusyError();

    const requestId = randomUUID();
    const createdAt = new Date();
    const deadline = new Date(createdAt.getTime() + input.timeoutMs);
    const row: PendingClarify = {
      requestId,
      sessionId: input.sessionId,
      surfaceType: input.surfaceType,
      surfaceContext: input.surfaceContext ?? {},
      question: input.question,
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.default !== undefined ? { default: input.default } : {}),
      answerableBy: input.answerableBy,
      createdAt: createdAt.toISOString(),
      defaultDeadlineAt: deadline.toISOString(),
    };

    // Persistence rule: the pending row goes to disk *before* it is presented,
    // so a surface that disappears between persist and present can re-present.
    await this.store.add(row);

    return new Promise<ClarifyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.fireTimeout(requestId);
      }, input.timeoutMs);
      this.pending.set(requestId, { row, resolve, reject, timer });

      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          void this.respond({ requestId, answer: '', source: 'cancel' });
        } else {
          input.abortSignal.addEventListener(
            'abort',
            () => void this.respond({ requestId, answer: '', source: 'cancel' }),
            { once: true },
          );
        }
      }

      // Present after the resolver is registered so a synchronous in-process
      // surface can call respond() immediately without racing the Map insert.
      Promise.resolve(this.presenter?.(row)).catch(() => {
        // A presenter failure must not wedge the turn — let the timeout fire.
      });
    });
  }

  /**
   * Resolve a pending clarify. Called by a surface when the user answers or
   * cancels, and internally on timeout. Unknown / already-resolved ids are
   * swallowed (another surface or the timeout beat this one).
   *
   * Degraded-mode fallback: when no in-process entry exists but the row is
   * still persisted (gateway crashed mid-clarify, then the user tapped the
   * button after restart), still clear the row and notify listeners so the
   * surface can edit its UI to the resolved state. The original `request()`
   * promise is gone — the agent waiting on it died with the process — so
   * the answer can't reach the LLM, but at least the visible prompt updates.
   */
  async respond(response: ClarifyResponse): Promise<void> {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      const persisted = await this.store.get(response.requestId);
      if (!persisted) return;
      await this.store.remove(response.requestId);
      const notify = response.source === 'timeout-no-default' ? null : response;
      this.notifyResolved(persisted, notify);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.requestId);
    await this.store.remove(response.requestId);

    if (response.source === 'timeout-no-default') {
      entry.reject(new ClarifyTimedOutNoDefaultError());
      this.notifyResolved(entry.row, null);
      return;
    }
    entry.resolve(response);
    this.notifyResolved(entry.row, response);
  }

  private notifyResolved(row: PendingClarify, response: ClarifyResponse | null): void {
    for (const listener of this.resolvedListeners) {
      try {
        listener(row, response);
      } catch {
        // A surface teardown failure must not break the resolution path.
      }
    }
  }

  /**
   * Restart recovery: fire timeout responses for any persisted rows that have
   * already passed their deadline. Called on boot and on an interval by
   * surfaces that outlive a single turn (web-api, gateway).
   *
   * Listeners are notified for swept rows so surfaces can edit their UI in
   * place — a card whose prompt timed out while the process was down should
   * still update to the "timed out" state instead of hanging on buttons.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    const expired = await this.store.expired(now);
    for (const row of expired) {
      if (this.pending.has(row.requestId)) continue; // a live timer will handle it
      await this.store.remove(row.requestId);
      const source = row.default !== undefined ? 'timeout-default' : 'timeout-no-default';
      const notify =
        source === 'timeout-default'
          ? ({ requestId: row.requestId, answer: row.default ?? '', source } as ClarifyResponse)
          : null;
      this.notifyResolved(row, notify);
    }
  }

  private async fireTimeout(requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    const def = entry.row.default;
    await this.respond({
      requestId,
      answer: def ?? '',
      source: def !== undefined ? 'timeout-default' : 'timeout-no-default',
    });
  }
}
