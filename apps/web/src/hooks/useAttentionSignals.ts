import { useEffect, useReducer, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  activityToAttentionAction,
  attentionCount,
  attentionReducer,
  emptyAttention,
} from '../lib/attention/attention-state';
import { browserFaviconDeps, renderDotFavicon } from '../lib/attention/favicon';
import { showAttentionNotification } from '../lib/attention/notify';
import { formatAttentionTitle, stripAttentionPrefix } from '../lib/attention/title';
import { getLastSessionId } from '../lib/lastSession';
import { isChatPathname, sessionOpenPath } from '../lib/workspaceRoutes';
import { subscribeToActivity, subscribeToSession } from '../sse';

// Browser attention signals: when a chat needs the user (approval, clarify,
// credential) and the tab is hidden, prefix the title with "(N) ", draw a dot
// on the favicon and optionally raise a system notification. Approvals and
// clarifies arrive on the merged activity stream; credential_required is
// excluded from it by design, so it comes from the active session's stream.
// The active-session tracking duplicates usePushEventToasts on purpose.

interface FaviconSnapshot {
  link: HTMLLinkElement;
  href: string | null;
  type: string | null;
}

function findIconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

/**
 * A fresh connection replays the server's activity buffer, so a request can
 * arrive just before its resolved event. Notify only if still pending after
 * this window.
 */
export const NOTIFY_DELAY_MS = 1500;

export function useAttentionSignals(): void {
  const [state, dispatch] = useReducer(attentionReducer, emptyAttention);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [sessionId, setSessionId] = useState<string | null>(() => getLastSessionId());
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const count = attentionCount(state);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const baseTitleRef = useRef<string | null>(null);
  const faviconRef = useRef<FaviconSnapshot | null>(null);
  const dotRef = useRef<string | null>(null);
  const dotPendingRef = useRef(false);
  const notifiedRef = useRef<Set<string>>(new Set());
  const stateRef = useRef(state);
  stateRef.current = state;
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Visibility.
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // Active session id (cross-tab storage event + in-tab change event).
  useEffect(() => {
    const refresh = () => setSessionId(getLastSessionId());
    window.addEventListener('storage', refresh);
    window.addEventListener('ethos:active-session-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('ethos:active-session-changed', refresh);
    };
  }, []);

  // Effect A: approvals + clarifies, every session. Own channel so the
  // Activity page's sinceSeq replay is not swallowed by this earlier opener.
  useEffect(() => {
    const sub = subscribeToActivity(null, {
      channel: 'attention',
      onEvent: (envelope) => {
        const action = activityToAttentionAction(envelope);
        if (action) dispatch(action);
      },
    });
    return () => sub.close();
  }, []);

  // Effect B: credential_required from the active session's stream.
  useEffect(() => {
    if (!sessionId) return;
    const sub = subscribeToSession(sessionId, {
      onEvent: (event, seq) => {
        if (event.type !== 'credential_required') return;
        const action = activityToAttentionAction({ sessionId, personalityId: null, event }, seq);
        if (action) dispatch(action);
      },
    });
    return () => sub.close();
  }, [sessionId]);

  // Viewing: an item for the chat the user is looking at is cleared at once.
  useEffect(() => {
    if (!visible || !isChatPathname(pathname)) return;
    const viewed = new URLSearchParams(search).get('session');
    if (viewed && state.items.some((i) => i.sessionId === viewed)) {
      dispatch({ type: 'view-session', sessionId: viewed });
    }
  }, [visible, pathname, search, state.items]);

  // Title + favicon.
  useEffect(() => {
    if (!visible && count > 0) {
      if (baseTitleRef.current === null) {
        baseTitleRef.current = stripAttentionPrefix(document.title);
      }
      document.title = formatAttentionTitle(baseTitleRef.current, count);
      applyDot(faviconRef, dotRef, dotPendingRef, visibleRef);
      return;
    }
    restore(baseTitleRef, faviconRef);
  }, [count, visible]);

  // Restore on unmount.
  useEffect(() => () => restore(baseTitleRef, faviconRef), []);

  // Notify once per item that arrives while hidden, after a short delay and
  // only if it is still pending then (drops replayed request/resolved pairs).
  useEffect(() => {
    const seen = notifiedRef.current;
    const timers = timersRef.current;
    for (const [key, timer] of timers) {
      if (!state.items.some((i) => i.key === key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }
    for (const item of state.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      if (visibleRef.current) continue;
      timers.set(
        item.key,
        setTimeout(() => {
          timers.delete(item.key);
          const pending = stateRef.current.items.find((i) => i.key === item.key);
          if (!pending || visibleRef.current) return;
          showAttentionNotification(pending, (it) =>
            navigate(sessionOpenPath(it.sessionId, it.personalityId)),
          );
        }, NOTIFY_DELAY_MS),
      );
    }
  }, [state.items, navigate]);

  // Cancel any pending notification timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
}

function applyDot(
  faviconRef: { current: FaviconSnapshot | null },
  dotRef: { current: string | null },
  pendingRef: { current: boolean },
  visibleRef: { current: boolean },
): void {
  if (faviconRef.current === null) {
    const link = findIconLink();
    if (!link) return; // No icon to decorate: title-only.
    faviconRef.current = {
      link,
      href: link.getAttribute('href'),
      type: link.getAttribute('type'),
    };
  }
  const snap = faviconRef.current;
  const show = (dot: string) => {
    snap.link.setAttribute('href', dot);
    snap.link.setAttribute('type', 'image/png');
  };
  if (dotRef.current) {
    show(dotRef.current);
    return;
  }
  if (pendingRef.current || snap.href === null) return;
  pendingRef.current = true;
  void renderDotFavicon(snap.href, browserFaviconDeps).then((dot) => {
    pendingRef.current = false;
    if (!dot) return; // Title-only fallback.
    dotRef.current = dot;
    // Apply only if the signal is still active (snapshot is cleared on restore).
    if (faviconRef.current === snap && !visibleRef.current) show(dot);
  });
}

function restore(
  baseTitleRef: { current: string | null },
  faviconRef: { current: FaviconSnapshot | null },
): void {
  if (baseTitleRef.current !== null) {
    document.title = baseTitleRef.current;
    baseTitleRef.current = null;
  }
  const snap = faviconRef.current;
  if (snap) {
    setOrRemove(snap.link, 'href', snap.href);
    setOrRemove(snap.link, 'type', snap.type);
    faviconRef.current = null;
  }
}

function setOrRemove(link: HTMLLinkElement, name: string, value: string | null): void {
  if (value === null) link.removeAttribute(name);
  else link.setAttribute(name, value);
}
