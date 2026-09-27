import { type SseEvent, SseEventSchema } from '@ethosagent/web-contracts';

/**
 * Structural subset of `ZodType<T>` — just enough to parse a frame. Avoids
 * adding a direct `zod` dependency to this package for one field; any
 * `ZodType` (e.g. `ActivityEventSchema`) already satisfies this.
 */
export interface EventSchema<T> {
  parse(data: unknown): T;
}

export interface EventStreamOptions<T = SseEvent> {
  baseUrl: string;
  apiKey?: string;
  /**
   * Required unless `path` is given (the URL is then built from `path`
   * alone, e.g. a non-session feed like `/sse/activity`). Providing
   * neither is a runtime error.
   */
  sessionId?: string;
  /**
   * Path to stream, e.g. `/sse/activity` or `/sse/kanban/:team`. Default:
   * `/sse/sessions/${sessionId}` — unchanged from before this option
   * existed, so every caller that doesn't pass it keeps its current URL.
   */
  path?: string;
  sinceSeq?: number;
  signal?: AbortSignal;
  /** Injectable fetch (e.g. `expo/fetch`). Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Reconnect delay policy. `'fixed'` (default) is the original flat 3s
   * retry the web client already relies on. `'backoff'` is exponential
   * full-jitter, 1s -> 30s cap, reset on a successful connect or by calling
   * `resetBackoff()` (the phone does this on AppState foreground and on a
   * NetInfo change, per D13 in plan/phases/mobile-app.md).
   */
  retry?: 'fixed' | 'backoff';
  /**
   * Parses each frame's `data:` JSON. Defaults to `SseEventSchema` — pass a
   * different schema (e.g. `ActivityEventSchema`) to stream a feed whose
   * frames aren't a bare `SseEvent`, such as `/sse/activity`'s
   * `{ sessionId, personalityId, event }` envelope. `T` follows the schema.
   */
  schema?: EventSchema<T>;
  onEvent: (event: T, seq: number) => void;
  onError?: (err: unknown) => void;
  /**
   * Fired when the resumed stream reports a replay gap — the server's
   * `SessionStreamBuffer` evicted frames at capacity, or reaped the session
   * outright, before this client's `sinceSeq` (D13). Signalled on the wire
   * as an `event: gap` SSE frame with no `id:` line, so it never advances
   * `lastSeq` and an app that doesn't pass `onGap` simply never sees it.
   * Pinned by this file's `__tests__/stream.test.ts`.
   */
  onGap?: () => void;
}

export interface EventStreamSubscription {
  close(): void;
  readonly lastSeq: number;
  readonly closed: boolean;
  /** Reset the backoff attempt counter back to its first delay. No-op under
   * `retry: 'fixed'`. */
  resetBackoff(): void;
}

const RETRY_DELAY_MS = 3000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
/** No bytes at all for this long on an otherwise-open connection means the
 * connection is dead in a way the transport didn't tell us about — abort
 * and let the retry loop reconnect. */
export const STALL_MS = 35_000;

export function EventStream<T = SseEvent>(opts: EventStreamOptions<T>): EventStreamSubscription {
  if (!opts.path && !opts.sessionId) {
    throw new Error('EventStream requires either a path or a sessionId');
  }
  const base = opts.baseUrl.replace(/\/+$/, '');
  const path = opts.path ?? `/sse/sessions/${opts.sessionId}`;
  const url = new URL(`${base}${path}`);
  if (opts.sinceSeq && opts.sinceSeq > 0) {
    url.searchParams.set('lastEventId', String(opts.sinceSeq));
  }

  const ac = new AbortController();
  const state = { lastSeq: opts.sinceSeq ?? 0, closed: false, attempt: 0 };

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // Nothing awaits the loop, so nothing may escape it: a refused connection, a
  // body read that the stall watchdog or close() aborted, and a throwing
  // callback all end inside `consume`. This catch is the backstop — under
  // Expo Go an unhandled rejection is a full-screen error, not a log line.
  consume(url.toString(), opts, ac.signal, state).catch(() => {
    state.closed = true;
  });

  return {
    close() {
      state.closed = true;
      ac.abort();
    },
    get lastSeq() {
      return state.lastSeq;
    },
    get closed() {
      return state.closed;
    },
    resetBackoff() {
      state.attempt = 0;
    },
  };
}

/** AWS-style full jitter: uniform(0, min(cap, base * 2^attempt)). */
function fullJitterDelayMs(attempt: number): number {
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.random() * cap;
}

async function consume<T>(
  url: string,
  opts: EventStreamOptions<T>,
  outerSignal: AbortSignal,
  state: { lastSeq: number; closed: boolean; attempt: number },
): Promise<void> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const schema = opts.schema ?? (SseEventSchema as unknown as EventSchema<T>);
  // A throwing `onError` must not end the retry loop (or reject it).
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // The caller's handler failed; the stream keeps its own course.
    }
  };

  while (!outerSignal.aborted) {
    // A per-attempt controller: aborting it (stall watchdog, or the outer
    // signal) ends only this fetch, not the whole retry loop.
    const attemptController = new AbortController();
    const onOuterAbort = () => attemptController.abort();
    outerSignal.addEventListener('abort', onOuterAbort);

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => attemptController.abort(), STALL_MS);
    };
    let failed = false;

    try {
      armWatchdog();
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
      // In addition to the `?lastEventId` query below (kept for the routes
      // that only read it): a real `Last-Event-ID` header, same as a
      // browser's native EventSource sends on reconnect.
      if (opts.sinceSeq && opts.sinceSeq > 0) {
        headers['Last-Event-ID'] = String(opts.sinceSeq);
      }

      const res = await fetchFn(url, {
        headers,
        ...(!opts.apiKey ? { credentials: 'include' as RequestCredentials } : {}),
        signal: attemptController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
      }
      // Connected — a future failure starts backoff from its first delay.
      state.attempt = 0;

      const body = res.body;
      if (!body) throw new Error('Response body is null');

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentId = '';
      let currentEvent = '';
      let currentData = '';

      for (;;) {
        const { done, value } = await reader.read();
        armWatchdog();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('id:')) {
            currentId = line.slice(3).trim();
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            currentData += line.slice(5);
          } else if (line === '') {
            if (currentEvent === 'gap') {
              // No `id:` line on this frame — never advances `lastSeq`.
              try {
                opts.onGap?.();
              } catch (err) {
                report(err);
              }
            } else if (currentData) {
              const seq = currentId ? Number(currentId) : state.lastSeq + 1;
              try {
                const json = JSON.parse(currentData) as unknown;
                const event = schema.parse(json);
                state.lastSeq = seq;
                opts.onEvent(event, seq);
              } catch (err) {
                report(err);
              }
            }
            currentId = '';
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      failed = true;
      if (outerSignal.aborted) break;
      report(err);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      outerSignal.removeEventListener('abort', onOuterAbort);
    }

    if (outerSignal.aborted) break;
    if (failed) state.attempt += 1;
    const delay = opts.retry === 'backoff' ? fullJitterDelayMs(state.attempt) : RETRY_DELAY_MS;
    await new Promise((r) => setTimeout(r, delay));
  }

  state.closed = true;
}
