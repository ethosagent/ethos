import { type SseEvent, SseEventSchema } from '@ethosagent/web-contracts';

// Thin wrapper around the browser's native EventSource for the chat /
// approval / push-notification stream. Two responsibilities:
//
//   1. Parse every `data:` line through the shared Zod schema so handlers
//      see fully-typed `SseEvent`s — drift between server and client
//      surfaces here as a runtime parse error rather than silent type
//      confusion.
//
//   2. Surface the `id:` line (the buffer seq) so callers can resume
//      cleanly. The browser already echoes the last seen id on reconnect
//      via `Last-Event-ID`; the app rarely needs to read it directly, but
//      tests + multi-tab debugging do.
//
// The browser handles reconnect-on-drop natively. We intentionally do NOT
// add a custom keepalive layer (the praxis-stack pivot deleted that work
// for SSE; see plan/phases/26-web-ui.md "Findings deleted by stack pivot").
//
// Connection sharing: a single chat page has several independent consumers
// (useChat, useDrawerStream, usePushEventToasts, StatusBar, Activity) that
// each subscribe to the same session. Opening one EventSource per call
// would exhaust the browser's ~6-per-origin HTTP/1.1 connection pool and
// stall every REST/RPC fetch behind the duplicates. So all subscribers for
// a given session share ONE underlying EventSource, fanned out in-process
// and reference-counted.

export interface SseSubscriberOptions {
  /** Override the URL base. Defaults to same-origin. */
  apiBase?: string;
  /** Resume cursor — server replays everything with `seq > sinceSeq`. */
  sinceSeq?: number;
  /** Called for every event the server sends. Errors thrown here propagate
   *  to `onError`. */
  onEvent: (event: SseEvent, seq: number) => void;
  /** Connection-level errors (parse failures, dropped sockets). The
   *  EventSource will keep trying to reconnect even after these — return
   *  `'close'` from this handler to abort. Returning anything else (or
   *  nothing) keeps the stream open. */
  onError?: (err: unknown) => 'close' | undefined;
}

export interface SseSubscription {
  close(): void;
  /** Last seq the client observed. Useful for debugging mid-flight resume. */
  readonly lastSeq: number;
}

interface Subscriber {
  onEvent: (event: SseEvent, seq: number) => void;
  onError?: (err: unknown) => 'close' | undefined;
}

interface SharedConnection {
  source: EventSource;
  subscribers: Set<Subscriber>;
  lastSeq: number;
}

// Keyed by `${base}|${sessionId}` so a differing apiBase doesn't collide
// (in practice all callers use the default). Module-local state is fine —
// this file only ever runs in a single React app instance.
const connections = new Map<string, SharedConnection>();

/**
 * Open the SSE stream for a session. Returns immediately with a handle the
 * caller `close()`s when their UI unmounts.
 *
 * All subscribers for the same session share one EventSource. The first
 * subscriber opens it (using its `sinceSeq` for the `lastEventId` query
 * param); later subscribers attach to the live connection and receive
 * events from the current point forward — they do NOT get a replay of
 * events emitted before they joined. That's acceptable here because every
 * caller is a live consumer, not a resume-from-cursor reader.
 */
export function subscribeToSession(sessionId: string, opts: SseSubscriberOptions): SseSubscription {
  const base = opts.apiBase ?? import.meta.env.VITE_API_URL ?? '';
  const key = `${base}|${sessionId}`;

  const subscriber: Subscriber = { onEvent: opts.onEvent, onError: opts.onError };

  let conn = connections.get(key);
  if (!conn) {
    const url = new URL(`${base}/sse/sessions/${sessionId}`, window.location.origin);
    if (opts.sinceSeq && opts.sinceSeq > 0) {
      // EventSource doesn't let us set request headers, so encode the
      // resume hint as a query param. The server reads `Last-Event-ID` for
      // browser-driven reconnects; this is the explicit-resume escape
      // hatch (e.g. tests, "rewind" UI later).
      url.searchParams.set('lastEventId', String(opts.sinceSeq));
    }

    const source = new EventSource(url.toString(), { withCredentials: true });
    const created: SharedConnection = {
      source,
      subscribers: new Set([subscriber]),
      lastSeq: opts.sinceSeq ?? 0,
    };
    connections.set(key, created);
    conn = created;

    source.onmessage = (raw) => {
      const seq = raw.lastEventId ? Number(raw.lastEventId) : created.lastSeq + 1;
      let parsed: SseEvent;
      try {
        const json = JSON.parse(raw.data) as unknown;
        parsed = SseEventSchema.parse(json);
      } catch (err) {
        // A bad event is surfaced but the stream stays open — the browser's
        // auto-reconnect would re-fire on drop, but a one-off parse error
        // shouldn't tear down a working subscription. A subscriber asking to
        // `'close'` only detaches itself; the shared socket survives for the
        // others.
        for (const sub of [...created.subscribers]) {
          if (sub.onError?.(err) === 'close') created.subscribers.delete(sub);
        }
        closeIfEmpty(key, created);
        return;
      }
      created.lastSeq = seq;
      for (const sub of [...created.subscribers]) {
        try {
          sub.onEvent(parsed, seq);
        } catch (err) {
          // One subscriber throwing must not break fan-out to the others.
          if (sub.onError?.(err) === 'close') created.subscribers.delete(sub);
        }
      }
      closeIfEmpty(key, created);
    };

    source.onerror = (err) => {
      for (const sub of [...created.subscribers]) {
        if (sub.onError?.(err) === 'close') created.subscribers.delete(sub);
      }
      closeIfEmpty(key, created);
    };
  } else {
    conn.subscribers.add(subscriber);
  }

  const shared = conn;
  return {
    close: () => {
      shared.subscribers.delete(subscriber);
      closeIfEmpty(key, shared);
    },
    get lastSeq() {
      return shared.lastSeq;
    },
  };
}

/** Tear down the real EventSource once the last subscriber has left. A
 *  subsequent subscribe re-opens it. */
function closeIfEmpty(key: string, conn: SharedConnection): void {
  if (conn.subscribers.size > 0) return;
  conn.source.close();
  // Only drop the entry if it's still the live one for this key — a
  // re-subscribe during teardown could already have replaced it.
  if (connections.get(key) === conn) connections.delete(key);
}
