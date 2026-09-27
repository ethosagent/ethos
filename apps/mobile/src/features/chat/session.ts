import { isTerminalRun } from '@ethosagent/chat-state';
import type { EthosClient } from '@ethosagent/sdk';
import type { ApprovalRequest, ApprovalScope } from '@ethosagent/web-contracts';
import { opener, streams } from '../../api/client';
import { errorRow } from '../../api/errors';
import { createForegroundPolicy } from '../../api/foreground';
import { queryClient } from '../../api/queries';
import { clock } from '../../lib/row';
import { useChatStore } from '../../state/chat-store';
import { useConnection } from '../../state/connection';
import { foldPending, NEEDS_YOU_KEY } from '../activity/needs-you';

// One chat session's life on the phone: open it (history, then stream, then
// catch-up), send / steer / stop, answer approvals and questions. The reducer
// lives in src/state; this module only talks to the server and dispatches.

type Rpc = EthosClient['rpc'];

let clientIdValue: string | null = null;
/** This install's `clientId` — `approval.resolved.decidedBy` names it. */
export function clientId(): string {
  clientIdValue ??= `mobile-${crypto.randomUUID()}`;
  return clientIdValue;
}

const store = () => useChatStore.getState();
const rpc = (): Rpc | null => useConnection.getState().client?.rpc ?? null;

/** The newest history page. `first` on open (`history-loaded`); a re-hydrate
 *  keeps the older pages already loaded (`history-newest-merged`, D13). */
export async function loadNewest(api: Rpc, first: boolean): Promise<void> {
  const { sessionId } = store();
  if (!sessionId) return;
  const page = await api.sessions.messages({ id: sessionId });
  store().dispatch({
    type: first ? 'history-loaded' : 'history-newest-merged',
    messages: page.messages,
    cards: page.cards,
  });
  if (first) useChatStore.setState({ olderCursor: page.nextCursor });
}

/** Scroll-up: the next-older page, prepended. Fired and forgotten by the
 *  list (`ChatSurface`'s `onOlder`), so it never rejects: a failed page is a
 *  resolved row, and the cursor comes back so the next scroll-up retries. */
export async function loadOlder(api: Rpc): Promise<void> {
  const { sessionId, olderCursor } = store();
  if (!sessionId || !olderCursor) return;
  useChatStore.setState({ olderCursor: null });
  let page: Awaited<ReturnType<Rpc['sessions']['messages']>>;
  try {
    page = await api.sessions.messages({ id: sessionId, before: olderCursor });
  } catch (err) {
    if (store().sessionId !== sessionId) return;
    useChatStore.setState({ olderCursor });
    store().notice(errorRow(err, 'sessions.messages'));
    return;
  }
  if (store().sessionId !== sessionId) return;
  store().dispatch({ type: 'history-older-loaded', messages: page.messages, cards: page.cards });
  useChatStore.setState({ olderCursor: page.nextCursor });
}

/** What the stream cannot replay: pending approvals, parked questions, runs. */
export async function catchUp(api: Rpc): Promise<void> {
  const { sessionId, rootKey } = store();
  if (!sessionId) return;
  try {
    store().reconcile(await api.tools.listPending({ sessionId }));
    if (!rootKey) return;
    const questions = await api.clarify.listPending({ rootSessionKey: rootKey });
    if (questions.length > 0) {
      store().dispatch({
        type: 'clarify-restored',
        pending: questions.map((q) => ({ type: 'clarify.request' as const, ...q })),
      });
    }
    const now = Date.now();
    const runs = (await api.tasks.list({ rootSessionKey: rootKey }))
      .filter((row) => !isTerminalRun(row.status))
      .map((row) => ({
        jobId: row.id,
        runner: row.runner ?? 'ethos',
        status: row.status,
        spendUsd: row.spendUsd,
        elapsedMs: Math.max(0, now - (row.startedAt ?? row.createdAt)),
      }));
    if (runs.length > 0) store().dispatch({ type: 'runs-restored', runs, timestamp: now });
  } catch {
    // Best-effort: a failed read leaves the last state on screen.
  }
}

/** D13, wired to the live connection. `app/_layout.tsx` feeds it AppState. */
export const foreground = createForegroundPolicy({
  now: () => Date.now(),
  suspend: () => streams.suspend(),
  resume: (fresh) => streams.resume(fresh),
  rehydrate: async () => {
    const api = rpc();
    if (api) await loadNewest(api, false);
  },
  catchUp: async () => {
    const api = rpc();
    if (api) await catchUp(api);
  },
  reportError: (err) => store().notice(errorRow(err, 'sessions.messages')),
});

function subscribe(sessionId: string): void {
  const { url, key } = useConnection.getState();
  if (!url || !key) return;
  streams.openSession(
    `/sse/sessions/${encodeURIComponent(sessionId)}`,
    opener(url, key, {
      onEvent: (event) => {
        store().receive(event);
        // Keeps the Activity badge current without a second stream (R6a).
        if (event.type === 'approval.resolved' || event.type === 'tool.approval_required') {
          queryClient.setQueryData<ApprovalRequest[]>(NEEDS_YOU_KEY, (list) =>
            list ? foldPending(list, event) : list,
          );
        }
      },
      onGap: () => void foreground.onGap(),
    }),
  );
}

/** Open a session: history first, then the stream, then the catch-up (D13). */
export async function openSession(api: Rpc, sessionId: string): Promise<void> {
  store().reset(sessionId);
  const [session] = await Promise.all([
    api.sessions.get({ id: sessionId, withMessages: false }),
    loadNewest(api, true),
  ]);
  if (store().sessionId !== sessionId) return;
  useChatStore.setState({ rootKey: session.session.key });
  subscribe(sessionId);
  await catchUp(api);
}

/** The first `chat.send` of a new session answered with its id: follow it
 *  without a reset, so the optimistic bubble stays. The stream opens without
 *  a cursor, so the server replays the turn from its start. Never rejects —
 *  the composer's send is fired and forgotten; a failed `sessions.get` (the
 *  server gone between the send and this read) is a resolved row, and the
 *  stream already open keeps retrying. */
export async function adoptSession(api: Rpc, sessionId: string): Promise<void> {
  useChatStore.setState({ sessionId });
  subscribe(sessionId);
  try {
    const session = await api.sessions.get({ id: sessionId, withMessages: false });
    if (store().sessionId === sessionId) useChatStore.setState({ rootKey: session.session.key });
  } catch (err) {
    if (store().sessionId === sessionId) store().notice(errorRow(err, 'sessions.get'));
  }
}

/**
 * Send, or steer the turn in flight. Offline is refused with a resolved row —
 * never queued (§11: a queued message is a decision taken later on stale
 * facts). Returns the session id `chat.send` answered with, or null.
 */
export async function sendMessage(
  api: Rpc,
  opts: { text: string; online: boolean; personalityId: string | null },
): Promise<string | null> {
  const text = opts.text.trim();
  if (!text) return null;
  const { sessionId, chat } = store();
  if (!opts.online) {
    store().notice({
      glyph: '✗',
      word: 'offline',
      subject: 'chat.send',
      result: 'not sent',
      time: clock(Date.now()),
    });
    return null;
  }
  if (sessionId && chat.isStreaming) {
    const res = await api.chat.steer({ sessionId, text }).catch(() => ({ ok: false }));
    if (res.ok) {
      store().dispatch({
        type: 'steer-user-message',
        id: `steer-${Date.now()}`,
        text,
        timestamp: Date.now(),
      });
    }
    return sessionId;
  }
  const id = `user-${Date.now()}`;
  store().dispatch({ type: 'submit-user-message', id, text, timestamp: Date.now() });
  try {
    const res = await api.chat.send({
      ...(sessionId ? { sessionId } : {}),
      clientId: clientId(),
      text,
      ...(opts.personalityId ? { personalityId: opts.personalityId } : {}),
    });
    return res.sessionId;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    store().dispatch({ type: 'send-failed', userMessageId: id, error });
    return null;
  }
}

export async function abortTurn(api: Rpc): Promise<void> {
  const { sessionId } = store();
  if (!sessionId) return;
  store().dispatch({ type: 'abort-turn' });
  try {
    await api.chat.abort({ sessionId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store().dispatch({ type: 'abort-failed', reason });
  }
}

export function decideApproval(
  api: Rpc,
  approvalId: string,
  decision: { allow: true; scope: ApprovalScope } | { allow: false },
): Promise<unknown> {
  return decision.allow
    ? api.tools.approve({ approvalId, clientId: clientId(), scope: decision.scope })
    : api.tools.deny({ approvalId, clientId: clientId() });
}
