// N5a (plan ux-feedback-and-config-clarity §4) — one unsaved-changes guard for
// every page that holds a draft: Settings, the Memory editor, the Personality
// edit modal.
//
// Two exits are covered:
//
//   1. Leaving the app (reload, tab close, external link) — a `beforeunload`
//      listener; the browser renders its own generic prompt.
//   2. In-app navigation — the app mounts a DECLARATIVE `<BrowserRouter>`
//      (apps/web/src/main.tsx), and `useBlocker` is data/framework-mode only
//      (react-router's own `@mode` annotation), so this wraps the navigator's
//      `push`/`replace` through `UNSAFE_NavigationContext` and asks
//      `window.confirm` before letting a navigation through. That intercepts
//      every `<Link>` and `useNavigate` call, which is all in-app chrome.
//
// KNOWN LIMIT: browser back/forward (popstate) is not intercepted — the
// declarative router exposes no seam for it short of a data-router migration.
// `beforeunload` still catches the cases where history leaves the app.
//
// `dirty` may be a boolean or a thunk: a thunk lets a caller whose dirty state
// lives in a ref (the Personality edit modal) answer at navigation time
// without re-rendering on every keystroke.

import { useContext, useEffect, useRef } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

const DEFAULT_MESSAGE = 'You have unsaved changes — leave this page and lose them?';

export function useUnsavedGuard(dirty: boolean | (() => boolean), message = DEFAULT_MESSAGE) {
  // Null outside a <Router> (component tests mount modals bare); the in-app
  // half then has nothing to guard and only `beforeunload` arms.
  const navigator = useContext(UNSAFE_NavigationContext)?.navigator;
  // Read at event time, not effect time, so the listeners install once and a
  // keystroke never tears down / re-arms the navigator patch mid-navigation.
  const isDirtyRef = useRef<() => boolean>(() => false);
  isDirtyRef.current = typeof dirty === 'function' ? dirty : () => dirty;
  const messageRef = useRef(message);
  messageRef.current = message;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current()) return;
      e.preventDefault();
      // Chrome requires returnValue to be set for the prompt to appear.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (!navigator) return;
    const push = navigator.push;
    const replace = navigator.replace;
    const guard =
      <A extends unknown[]>(original: (...args: A) => void) =>
      (...args: A) => {
        if (isDirtyRef.current() && !window.confirm(messageRef.current)) return;
        original(...args);
      };
    navigator.push = guard(push);
    navigator.replace = guard(replace);
    return () => {
      navigator.push = push;
      navigator.replace = replace;
    };
  }, [navigator]);
}
