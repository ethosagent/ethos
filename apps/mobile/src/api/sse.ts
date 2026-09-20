import type { EventStreamSubscription } from '@ethosagent/sdk';

// The two-stream budget (R6a, §1). On iOS every stream and every RPC to one
// host share `httpMaximumConnectionsPerHost` — six under HTTP/1.1 — so the app
// holds at most TWO SSE streams: the open session's, and the focused tab's feed
// (`/sse/activity` on Activity, `/sse/system` on More, `/sse/kanban/:team` on a
// team screen). Two slots is the whole enforcement: opening a feed replaces the
// previous feed, and nothing but `openSession` touches the session slot. Pinned
// by src/api/__tests__/sse-budget.test.ts.

/** Opens one stream at `path`, resuming after `sinceSeq` when given. */
export type OpenStream = (path: string, sinceSeq: number | undefined) => EventStreamSubscription;

type Slot = 'session' | 'feed';

interface Held {
  path: string;
  open: OpenStream;
  sub: EventStreamSubscription | null;
  /** Last seq seen when the stream was suspended, for the resume. */
  lastSeq: number;
}

export interface Streams {
  openSession(path: string, open: OpenStream): void;
  openFeed(path: string, open: OpenStream): void;
  /** Close the feed — only if `path` is still the one held, so a screen losing
   *  focus cannot close the feed the next screen already opened. */
  closeFeed(path: string): void;
  closeSession(): void;
  /** Disconnect: close both and forget them. */
  closeAll(): void;
  /** AppState `background`: close every stream, remember where each was (R6d). */
  suspend(): void;
  /** AppState `active`: reopen what `suspend` closed — resuming after the last
   *  seq, or from now when `fresh` (after a rehydrate, D13). */
  resume(fresh: boolean): void;
  openCount(): number;
}

export function createStreams(): Streams {
  const slots: Record<Slot, Held | null> = { session: null, feed: null };

  const close = (slot: Slot): void => {
    slots[slot]?.sub?.close();
    slots[slot] = null;
  };
  const start = (slot: Slot, path: string, open: OpenStream): void => {
    close(slot);
    slots[slot] = { path, open, sub: open(path, undefined), lastSeq: 0 };
  };

  return {
    openSession: (path, open) => start('session', path, open),
    openFeed: (path, open) => start('feed', path, open),
    closeFeed(path) {
      if (slots.feed?.path === path) close('feed');
    },
    closeSession: () => close('session'),
    closeAll() {
      close('session');
      close('feed');
    },
    suspend() {
      for (const held of [slots.session, slots.feed]) {
        if (!held?.sub) continue;
        held.lastSeq = held.sub.lastSeq;
        held.sub.close();
        held.sub = null;
      }
    },
    resume(fresh) {
      for (const held of [slots.session, slots.feed]) {
        if (!held || held.sub) continue;
        held.sub = held.open(held.path, fresh || held.lastSeq === 0 ? undefined : held.lastSeq);
      }
    },
    openCount: () => [slots.session, slots.feed].filter((h) => h?.sub && !h.sub.closed).length,
  };
}
