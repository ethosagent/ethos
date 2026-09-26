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

interface GuardEntry {
  isDirty: () => boolean;
  message: () => string;
}

interface NavigatorPatch {
  guards: Set<GuardEntry>;
  restore: () => void;
}

// ONE patch per navigator, shared by every mounted guard (Memory renders two
// MemoryEditor tabs, both alive at once). The per-hook wrap/restore pattern
// broke with siblings: cleanups run first-to-last, so the first unmount
// restored the true original and the second restored the first's DEAD wrapper
// — an unmounted component's guard stayed patched into the router, and if it
// was dirty at unmount every later in-app navigation prompted until reload.
// Here guards ref-count into one Set; the originals are restored only when
// the last guard leaves. Pinned by the sibling cases in
// `__tests__/useUnsavedGuard.test.ts`.
const navigatorPatches = new WeakMap<object, NavigatorPatch>();

function acquireNavigatorPatch(navigator: {
  push: (...args: never[]) => void;
  replace: (...args: never[]) => void;
}): NavigatorPatch {
  const existing = navigatorPatches.get(navigator);
  if (existing) return existing;

  const push = navigator.push;
  const replace = navigator.replace;
  const guards = new Set<GuardEntry>();
  const gate =
    <A extends never[]>(original: (...args: A) => void) =>
    (...args: A) => {
      // Each dirty guard gets its own confirm (their messages can differ);
      // any decline blocks the navigation.
      for (const guard of [...guards]) {
        if (guard.isDirty() && !window.confirm(guard.message())) return;
      }
      original(...args);
    };
  navigator.push = gate(push);
  navigator.replace = gate(replace);

  const patch: NavigatorPatch = {
    guards,
    restore: () => {
      navigator.push = push;
      navigator.replace = replace;
    },
  };
  navigatorPatches.set(navigator, patch);
  return patch;
}

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
    const entry: GuardEntry = {
      isDirty: () => isDirtyRef.current(),
      message: () => messageRef.current,
    };
    const patch = acquireNavigatorPatch(navigator);
    patch.guards.add(entry);
    return () => {
      patch.guards.delete(entry);
      if (patch.guards.size === 0 && navigatorPatches.get(navigator) === patch) {
        patch.restore();
        navigatorPatches.delete(navigator);
      }
    };
  }, [navigator]);
}
