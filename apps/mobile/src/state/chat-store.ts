import {
  applyAction,
  applyEvent,
  type ChatAction,
  type ChatState,
  initialChatState,
} from '@ethosagent/chat-state';
import type { ApprovalRequest, SseEvent } from '@ethosagent/web-contracts';
import { create } from 'zustand';
import { reconcileApprovals } from '../features/approvals/reconcile';
import type { RowData } from '../lib/row';

// `src/state` is the only place a store wraps the shared reducer (R4a). SSE
// events are buffered OUTSIDE React and applied at most once per animation
// frame, so a token stream costs one store update per frame, not per delta.
// Components select what they render, so only the streaming bubble and the
// status line re-render on a token.

interface ChatStore {
  sessionId: string | null;
  /** The session's key — `clarify.listPending` / `tasks.list` are scoped by it. */
  rootKey: string | null;
  chat: ChatState;
  /** `sessions.messages` cursor for the next-older page; null at the start. */
  olderCursor: string | null;
  /** Resolved rows that belong to the session but to no turn (D7). */
  notices: RowData[];
  /** Apply a UI/lifecycle action — after any buffered events, never before. */
  dispatch(action: ChatAction): void;
  /** Buffer one stream event; flushed on the next frame. */
  receive(event: SseEvent): void;
  notice(row: RowData): void;
  /** Foreground catch-up: the server's pending approvals for this session. */
  reconcile(server: ApprovalRequest[]): void;
  reset(sessionId: string | null, rootKey?: string | null): void;
}

let buffered: SseEvent[] = [];
let scheduled = false;
const nextFrame: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);

export const useChatStore = create<ChatStore>((set, get) => {
  const flush = (): void => {
    scheduled = false;
    if (buffered.length === 0) return;
    const events = buffered;
    buffered = [];
    const now = Date.now();
    set((s) => ({ chat: events.reduce((state, e) => applyEvent(state, e, now), s.chat) }));
  };

  return {
    sessionId: null,
    rootKey: null,
    chat: initialChatState,
    olderCursor: null,
    notices: [],
    dispatch(action) {
      flush();
      set((s) => ({ chat: applyAction(s.chat, action) }));
    },
    receive(event) {
      buffered.push(event);
      if (scheduled) return;
      scheduled = true;
      nextFrame(flush);
    },
    notice(row) {
      set((s) => ({ notices: [...s.notices, row] }));
    },
    reconcile(server) {
      flush();
      const { chat, notices } = get();
      const r = reconcileApprovals(chat.pendingApprovals, server, Date.now());
      set({ chat: { ...chat, pendingApprovals: r.pending }, notices: [...notices, ...r.resolved] });
    },
    reset(sessionId, rootKey = null) {
      buffered = [];
      set({
        sessionId,
        rootKey,
        chat: applyAction(get().chat, { type: 'reset' }),
        olderCursor: null,
        notices: [],
      });
    },
  };
});
