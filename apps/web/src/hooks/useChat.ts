import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { type AttachmentPreview, toMessageAttachment } from '../lib/attachments';
import {
  applyAction,
  applyEvent,
  type ChatAction,
  type ChatState,
  initialChatState,
  newestPageIsContiguous,
  type RestoredRun,
} from '../lib/chat-reducer';
import { getClientId } from '../lib/clientId';
import { broadcastTurnAborted } from '../lib/lastSession';
import { isTerminalRun } from '../lib/pi-run-reducer';
import { rpc } from '../rpc';
import { subscribeToSession } from '../sse';

// Top-level chat hook. Glues four moving pieces:
//   1. The chat reducer (lib/chat-reducer.ts) — pure state machine.
//   2. The SSE subscription (lib/sse.ts) — drives reducer with live events.
//   3. The oRPC mutations (chat.send) — kicks off new turns.
//   4. The history fetch (sessions.messages) — the newest page of whole turns
//      on mount when an existing session is opened; `loadOlder` walks back
//      one page at a time from there.
//
// `sessionId` is both an input AND output: callers can pass `undefined`
// to start a fresh session, and the hook surfaces the server-assigned id
// as `currentSessionId` once the first `chat.send` completes. Page-level
// routing then mirrors that to the URL.

export interface UseChatOptions {
  /** Existing session id to load. Pass undefined to start fresh. */
  initialSessionId?: string;
  /** Active personality id. Threaded into chat.send for tool/skill routing. */
  personalityId: string;
  /**
   * Called once when the server creates a session for a fresh chat.
   * Page-level code uses this to update the URL with the new id so a
   * refresh stays on the same conversation.
   */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Called when history load fails with a "not found" error — the session id
   * in the URL or localStorage no longer exists on the server. Callers should
   * clear their stored id and reset routing so the user gets a fresh chat.
   */
  onSessionNotFound?: (sessionId: string) => void;
  /**
   * The current session's string key. When a `cron.fired` SSE event arrives
   * with a matching sessionKey, the newest page of history is fetched again and
   * merged, so the cron turn appears in chat.
   */
  sessionKey?: string;
}

/** Where the next-older history page stands. `error` keeps the cursor. */
export type OlderHistoryStatus = 'idle' | 'loading' | 'error';

export interface UseChatResult {
  state: ChatState;
  /** Server-assigned session id once a turn has run. Null on a fresh chat
   *  before the user types anything. */
  currentSessionId: string | null;
  sendMessage: (
    text: string,
    attachments?: AttachmentPreview[],
    /** `replacesRefused` — a credential resend replaces the refused turn's
     *  bubble (`ChatState.credentialRefusedMessageId`) instead of adding one. */
    opts?: { origin?: 'text' | 'voice'; replacesRefused?: true },
  ) => Promise<void>;
  /** Steer the running turn. Returns true if accepted, false if the turn
   *  already ended or the RPC failed. */
  steerMessage: (text: string) => Promise<boolean>;
  /**
   * Abort the running turn. Acknowledged locally at once; if the RPC fails the
   * acknowledgement is withdrawn (`state.error` says Stop did not take).
   */
  abortTurn: () => Promise<void>;
  /**
   * Switch the in-flight session to a new id (e.g. after a fork). Wipes
   * local state synchronously so old messages don't linger while the
   * new session's history fetches.
   */
  switchSession: (sessionId: string) => void;
  /**
   * Drop the current session entirely — wipes reducer state and clears
   * `currentSessionId`. The next `sendMessage` will create a fresh
   * session on the server. Used by the "New session" affordance.
   */
  resetSession: () => void;
  /** Soft-delete the last N user+assistant turn pairs. Returns the
   *  number of pairs actually removed. */
  undoTurns: (n?: number) => Promise<number>;
  /** Force a server-side compaction (`/compact`). Returns pre/post token
   *  counts, or null when there's no session or the RPC failed. */
  compact: (instructions?: string) => Promise<{
    ok: boolean;
    engineName: string;
    droppedCount: number;
    preTotalTokens: number;
    postTotalTokens: number;
    summariesEnabled: boolean;
  } | null>;
  /**
   * Record the answer this tab gave a delegated run's question, so the resolved
   * card can name the decision (pi-delegation §4.5). `clarify.resolved` carries
   * only a source, never the answer.
   */
  noteClarifyAnswer: (requestId: string, answer: string) => void;
  /** Close the masked credential prompt (`state.pendingCredential`) unanswered. */
  dismissCredential: () => void;
  /**
   * Fetch the next-older page of history and prepend it. A no-op while a page
   * is in flight or when nothing is older; a page that lands after the session
   * was switched, reset or reloaded is dropped. After a failure, calling it
   * again retries the same page.
   */
  loadOlder: () => Promise<void>;
  /** The session has history older than what is loaded. */
  hasOlder: boolean;
  olderStatus: OlderHistoryStatus;
}

type Reducer = (state: ChatState, op: ReducerOp) => ChatState;
type ReducerOp =
  | { kind: 'event'; event: Parameters<typeof applyEvent>[1] }
  | { kind: 'action'; action: ChatAction };

const reducer: Reducer = (state, op) => {
  if (op.kind === 'event') return applyEvent(state, op.event, Date.now());
  return applyAction(state, op.action);
};

/**
 * The runs this session still has going, read from the durable job rows.
 *
 * The `run.update` digest is the run card's live feed and it has NO replay: a
 * page that connects mid-run misses every sample already published, and for a
 * run past its terminal sample there is no next one. `tasks.list` is the
 * catch-up — the same shape `ClarifyBridge.listPending` gives a reconnecting
 * surface for clarify rows.
 *
 * Terminal runs are deliberately excluded. Their card has nothing left to say,
 * and the sentence that matters — the completion hand-back — is a persisted
 * message that comes back with history on its own.
 */
export async function loadActiveRuns(
  rootSessionKey: string,
  now: number = Date.now(),
): Promise<RestoredRun[]> {
  const rows = await rpc.tasks.list({ rootSessionKey });
  return rows
    .filter((row) => !isTerminalRun(row.status))
    .map((row) => ({
      jobId: row.id,
      // Null on rows written before the runner seam existed; those ran on the
      // in-process default.
      runner: row.runner ?? 'ethos',
      status: row.status,
      spendUsd: row.spendUsd,
      elapsedMs: Math.max(0, now - (row.startedAt ?? row.createdAt)),
    }));
}

/**
 * The questions this session's runs are parked on, read from the durable
 * clarify rows.
 *
 * `loadActiveRuns`'s sibling, and the same gap: the `clarify.request` push has
 * no replay either, so the run card a mid-run mount just restored would show a
 * run "waiting on you" with nothing to answer. `ClarifyBridge.listPersisted`
 * has always been able to answer this — until now nothing exposed it to the
 * browser.
 *
 * Rows come back shaped as the event the live stream would have delivered, so
 * they fold into the one queue both paths share.
 */
export async function loadParkedQuestions(rootSessionKey: string): Promise<ClarifyRequestEvent[]> {
  const rows = await rpc.clarify.listPending({ rootSessionKey });
  return rows.map((row) => ({
    type: 'clarify.request' as const,
    requestId: row.requestId,
    question: row.question,
    ...(row.options ? { options: row.options } : {}),
    ...(row.default !== undefined ? { default: row.default } : {}),
    jobId: row.jobId,
    defaultDeadlineAt: row.defaultDeadlineAt,
  }));
}

export function useChat(opts: UseChatOptions): UseChatResult {
  const [state, dispatch] = useReducer(reducer, initialChatState);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    opts.initialSessionId ?? null,
  );

  // Callback props are read through a ref, updated every render, so a caller
  // passing an inline function (Chat.tsx does) never restarts the history
  // load — that effect re-runs only when the session changes.
  const onSessionNotFoundRef = useRef(opts.onSessionNotFound);
  onSessionNotFoundRef.current = opts.onSessionNotFound;
  // The latest reducer state, for the cron merge's contiguity check.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Track whether we've fetched history for this session so we don't
  // refetch on every render. A `useQuery` would also work but the data
  // is single-shot per session and feeds the reducer, which already owns
  // the canonical message list — useState is the right tool here.
  const historyLoadedFor = useRef<string | null>(null);

  // Paged history. The cursor lives in a ref, beside the session it belongs
  // to, so `loadOlder` stays referentially stable and a second call sees the
  // first in flight before React re-renders; `hasOlder`/`olderStatus` mirror
  // it for rendering. The pages themselves go straight into the reducer, which
  // stays the one owner of the message list. `pageGeneration` bumps whenever
  // the loaded history is replaced or wiped, so a page asked for before that
  // is recognised as stale and dropped.
  const olderCursor = useRef<{ sessionId: string; cursor: string } | null>(null);
  const olderInFlight = useRef(false);
  const pageGeneration = useRef(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderStatus, setOlderStatus] = useState<OlderHistoryStatus>('idle');

  const resetPaging = useCallback((sessionId: string | null, cursor: string | null) => {
    pageGeneration.current += 1;
    olderInFlight.current = false;
    olderCursor.current = sessionId !== null && cursor !== null ? { sessionId, cursor } : null;
    setHasOlder(olderCursor.current !== null);
    setOlderStatus('idle');
  }, []);

  // 0b. Rediscover runs that were already going when this page connected, and
  //     the questions any of them are parked on.
  //     A restore that fails leaves the transcript exactly as it was — the
  //     drawer and the status pill still carry the run, and a card that never
  //     appears is better than an error banner over a working conversation.
  const restoreRunState = useCallback(
    async (rootSessionKey: string, cancelled: () => boolean): Promise<void> => {
      try {
        const runs = await loadActiveRuns(rootSessionKey);
        if (cancelled() || runs.length === 0) return;
        dispatch({
          kind: 'action',
          action: { type: 'runs-restored', runs, timestamp: Date.now() },
        });
        // Chained behind the runs, and only when there ARE runs: the questions
        // are scoped to this session's live jobs, so with no run restored there
        // is nothing to ask about and no reason to spend the round trip.
        const pending = await loadParkedQuestions(rootSessionKey);
        if (cancelled() || pending.length === 0) return;
        dispatch({ kind: 'action', action: { type: 'clarify-restored', pending } });
      } catch {
        // best-effort
      }
    },
    [],
  );

  // 1. Load history when a session is in scope and we haven't fetched yet.
  useEffect(() => {
    if (!currentSessionId) return;
    if (historyLoadedFor.current === currentSessionId) return;

    const sessionId = currentSessionId;
    let cancelled = false;
    // The run restore needs the session's key, read from the session row alone
    // (`withMessages: false`) and started beside the page so it adds no wait.
    // Not from the React Query cache: `useChat` also runs where no
    // `useSessionGet` for this id sits beside it (QuickChat, the architect
    // flows), and the hook needs no QueryClient. Its failure only costs the
    // best-effort restore, so it is handled here and never surfaces.
    const sessionRow = rpc.sessions.get({ id: sessionId, withMessages: false });
    sessionRow.catch(() => undefined);
    rpc.sessions
      .messages({ id: sessionId })
      .then((page) => {
        if (cancelled) return;
        // Mark as loaded only after success so a Strict Mode
        // cancel+remount cycle retries rather than skipping.
        historyLoadedFor.current = sessionId;
        resetPaging(sessionId, page.nextCursor);
        dispatch({
          kind: 'action',
          action: {
            type: 'history-loaded',
            messages: page.messages,
            cards: page.cards,
            decisions: page.decisions,
          },
        });
        // Chained off the history load rather than run as its own effect for
        // one reason: `history-loaded` REPLACES `state.messages`, so a restore
        // that landed first would have its anchors thrown away.
        void sessionRow.then(
          (res) => restoreRunState(res.session.key, () => cancelled),
          () => undefined,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes('not found')) {
          // Stale session ID — reset silently so the user gets a fresh chat
          onSessionNotFoundRef.current?.(sessionId);
          historyLoadedFor.current = null;
          resetPaging(null, null);
          dispatch({ kind: 'action', action: { type: 'reset' } });
          setCurrentSessionId(null);
          return;
        }
        dispatch({
          kind: 'action',
          action: { type: 'send-failed', userMessageId: '', error: message },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, restoreRunState, resetPaging]);

  // 1b. The next-older page, on demand (the list's top sentinel, or Retry).
  const loadOlder = useCallback(async (): Promise<void> => {
    const from = olderCursor.current;
    if (!from || olderInFlight.current) return;
    olderInFlight.current = true;
    const generation = pageGeneration.current;
    setOlderStatus('loading');
    try {
      const page = await rpc.sessions.messages({ id: from.sessionId, before: from.cursor });
      if (generation !== pageGeneration.current) return;
      olderCursor.current =
        page.nextCursor !== null ? { sessionId: from.sessionId, cursor: page.nextCursor } : null;
      dispatch({
        kind: 'action',
        action: {
          type: 'history-older-loaded',
          messages: page.messages,
          cards: page.cards,
          decisions: page.decisions,
        },
      });
      setHasOlder(page.nextCursor !== null);
      setOlderStatus('idle');
    } catch {
      if (generation !== pageGeneration.current) return;
      // The cursor stays where it was, so the next call asks for this page again.
      setOlderStatus('error');
    } finally {
      if (generation === pageGeneration.current) olderInFlight.current = false;
    }
  }, []);

  // 1c. The newest page again, merged (`history-newest-merged`) — for a turn
  //     that reached this session outside this tab's stream: a `cron.fired`
  //     job. Best-effort: a failed read leaves the transcript as it was, and
  //     the next firing or reload catches up.
  const mergeNewest = useCallback(
    async (sessionId: string): Promise<void> => {
      // Before the first page lands, that load is already fetching the newest turns.
      if (historyLoadedFor.current !== sessionId) return;
      const generation = pageGeneration.current;
      try {
        const page = await rpc.sessions.messages({ id: sessionId });
        if (generation !== pageGeneration.current || historyLoadedFor.current !== sessionId) {
          return;
        }
        const contiguous = newestPageIsContiguous(stateRef.current.messages, page.messages);
        if (contiguous === null) return;
        // More than a page arrived: the merge replaces the whole history, so the
        // cursor restarts from this page and an older page in flight is dropped.
        // Contiguous, the older loaded pages stay and so does the cursor.
        if (!contiguous) resetPaging(sessionId, page.nextCursor);
        dispatch({
          kind: 'action',
          action: {
            type: 'history-newest-merged',
            messages: page.messages,
            cards: page.cards,
            decisions: page.decisions,
          },
        });
      } catch {
        // best-effort
      }
    },
    [resetPaging],
  );

  // 2. Subscribe to SSE for the current session. The wrapper handles
  //    reconnect via Last-Event-ID; we just dispatch every event into
  //    the reducer.
  useEffect(() => {
    if (!currentSessionId) return;
    const sub = subscribeToSession(currentSessionId, {
      onEvent: (event) => {
        dispatch({ kind: 'event', event });
        // When a cron job that ran in this session fires, merge the newest
        // page so the cron turn appears inline in the chat.
        if (
          event.type === 'cron.fired' &&
          event.sessionKey &&
          event.sessionKey === opts.sessionKey
        ) {
          void mergeNewest(currentSessionId);
        }
      },
      onError: () => {
        // Surface stays open — EventSource auto-reconnects. We don't set
        // an error here because connection blips during a long chat
        // shouldn't pollute the UI; only RPC failures and explicit
        // server `error` events do.
        return undefined;
      },
    });
    return () => sub.close();
  }, [currentSessionId, opts.sessionKey, mergeNewest]);

  // 3. Send a user message. Optimistically appends the user bubble,
  //    fires chat.send, and lets SSE drive the assistant response.
  const onSessionCreated = opts.onSessionCreated;
  const personalityId = opts.personalityId;
  // The turn a new question would cut off. `submit-user-message` runs `stopTurn`
  // exactly when `state.currentTurn` is non-null, so this reads the same fact —
  // as an id, so the callback is only rebuilt when the turn changes, not on
  // every delta.
  const interruptedTurnId = state.currentTurn?.id ?? null;
  const sendMessage = useCallback(
    async (
      text: string,
      attachments?: AttachmentPreview[],
      opts?: { origin?: 'text' | 'voice'; replacesRefused?: true },
    ): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed && !attachments?.length) return;

      const userMessageId = `user-${Date.now()}`;
      dispatch({
        kind: 'action',
        action: {
          type: 'submit-user-message',
          id: userMessageId,
          text: trimmed,
          timestamp: Date.now(),
          ...(attachments?.length ? { attachments: attachments.map(toMessageAttachment) } : {}),
          // The bubble carries the same "this arrived as speech" fact the
          // server is told below — the transcript is shown BESIDE the marker,
          // never instead of it.
          ...(opts?.origin === 'voice' ? { origin: 'voice' as const } : {}),
          ...(opts?.replacesRefused ? { replacesRefused: true as const } : {}),
        },
      });
      // A question asked over a live turn ends that turn — the reducer closes
      // its trail with the same `stopTurn` Stop uses. Neither path is on the
      // wire, so without this the separately-subscribed drawer keeps drawing
      // `running` rows for calls the footer has already settled (contract §4,
      // one trail two renderers). Nothing in flight, nothing to announce.
      if (currentSessionId && interruptedTurnId) broadcastTurnAborted(currentSessionId);

      try {
        const response = await rpc.chat.send({
          ...(currentSessionId ? { sessionId: currentSessionId } : {}),
          clientId: getClientId(),
          text: trimmed,
          ...(personalityId ? { personalityId } : {}),
          // Talk-mode marks its turns so the server can annotate them as
          // spoken. Typed sends omit it entirely.
          ...(opts?.origin === 'voice' ? { origin: 'voice' as const } : {}),
          ...(attachments?.length
            ? {
                attachments: attachments.map((a) => ({
                  type: a.type,
                  data: a.data ?? '',
                  mimeType: a.mimeType,
                  name: a.name,
                })),
              }
            : {}),
        });
        if (!currentSessionId && response.sessionId !== currentSessionId) {
          // We just created this session locally — the user message lives in
          // optimistic state and the assistant response will arrive via SSE.
          // Mark history as "loaded" BEFORE setCurrentSessionId so the
          // load effect skips its fetch. Otherwise it would race the agent
          // loop (which persists the user message asynchronously after
          // chat.send returns) and overwrite state.messages with an empty
          // array — wiping the optimistic user bubble and leaving only the
          // assistant response.
          historyLoadedFor.current = response.sessionId;
          setCurrentSessionId(response.sessionId);
          onSessionCreated?.(response.sessionId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dispatch({
          kind: 'action',
          action: { type: 'send-failed', userMessageId, error: message },
        });
      }
    },
    [currentSessionId, personalityId, onSessionCreated, interruptedTurnId],
  );

  const steerMessage = useCallback(
    async (text: string): Promise<boolean> => {
      if (!currentSessionId) return false;
      try {
        const res = await rpc.chat.steer({ sessionId: currentSessionId, text });
        if (res.ok) {
          dispatch({
            kind: 'action',
            action: {
              type: 'steer-user-message',
              id: `steer-${Date.now()}`,
              text,
              timestamp: Date.now(),
            },
          });
        }
        return res.ok;
      } catch {
        return false;
      }
    },
    [currentSessionId],
  );

  const abortTurn = useCallback(async (): Promise<void> => {
    if (!currentSessionId) return;
    // Recorded locally as well as sent: nothing in the SSE stream distinguishes
    // a turn that was ABANDONED from one that finished, and the trail footer
    // has to be able to say `✗ stopped` (feedback-activity-contract §3).
    dispatch({ kind: 'action', action: { type: 'abort-turn' } });
    // The drawer is on its own SSE subscription and an abort is not on the
    // wire, so without this it keeps drawing `running` rows for the calls this
    // dispatch just settled as failed (contract §4, one trail two renderers).
    broadcastTurnAborted(currentSessionId);
    try {
      await rpc.chat.abort({ sessionId: currentSessionId });
    } catch (err) {
      // The optimism has to be RECOVERABLE. `abort-turn` sets the suppression
      // guard, so a failed RPC would otherwise leave the surface permanently
      // blind while the server kept executing tools — reporting a turn stopped
      // while its side effects continued. Undo the guard, and say so.
      const reason = err instanceof Error ? err.message : String(err);
      dispatch({ kind: 'action', action: { type: 'abort-failed', reason } });
    }
  }, [currentSessionId]);

  const switchSession = useCallback(
    (sessionId: string) => {
      resetPaging(null, null);
      dispatch({ kind: 'action', action: { type: 'reset' } });
      setCurrentSessionId(sessionId);
    },
    [resetPaging],
  );

  const resetSession = useCallback(() => {
    resetPaging(null, null);
    dispatch({ kind: 'action', action: { type: 'reset' } });
    setCurrentSessionId(null);
    historyLoadedFor.current = null;
  }, [resetPaging]);

  const undoTurns = useCallback(
    async (n = 1): Promise<number> => {
      if (!currentSessionId) return 0;
      try {
        const res = await rpc.sessions.undoTurns({ id: currentSessionId, n });
        if (res.removed > 0) {
          dispatch({ kind: 'action', action: { type: 'undo-turns', count: res.removed } });
        }
        return res.removed;
      } catch {
        return 0;
      }
    },
    [currentSessionId],
  );

  // Phase 2 — manual `/compact`. Forces a server-side compaction (which persists
  // a watermark) and returns pre/post token counts so the caller can toast a
  // confirmation. No-op when there's no session yet.
  const compact = useCallback(
    async (
      instructions?: string,
    ): Promise<{
      ok: boolean;
      engineName: string;
      droppedCount: number;
      preTotalTokens: number;
      postTotalTokens: number;
      summariesEnabled: boolean;
    } | null> => {
      if (!currentSessionId) return null;
      try {
        return await rpc.sessions.compact({
          id: currentSessionId,
          ...(instructions ? { instructions } : {}),
        });
      } catch {
        return null;
      }
    },
    [currentSessionId],
  );

  // Remember the answer this tab gave a run's question, so the resolved card
  // can name the decision (§4.5). `clarify.resolved` carries only a source.
  const noteClarifyAnswer = useCallback((requestId: string, answer: string) => {
    dispatch({
      kind: 'action',
      action: { type: 'note-clarify-answer', requestId, answer, timestamp: Date.now() },
    });
  }, []);

  const dismissCredential = useCallback(() => {
    dispatch({ kind: 'action', action: { type: 'dismiss-credential' } });
  }, []);

  return {
    state,
    currentSessionId,
    sendMessage,
    steerMessage,
    abortTurn,
    switchSession,
    resetSession,
    undoTurns,
    compact,
    noteClarifyAnswer,
    dismissCredential,
    loadOlder,
    hasOlder,
    olderStatus,
  };
}
