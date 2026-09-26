// @vitest-environment jsdom
//
// N5a — the unsaved-changes guard. The app mounts a DECLARATIVE
// `<BrowserRouter>`, where react-router's `useBlocker` is unavailable
// (data/framework mode only), so the hook wraps the navigator's
// `push`/`replace` through `UNSAFE_NavigationContext` and arms `beforeunload`.
// This drives the real hook through a real render (`createRoot` + `act`, the
// `useMcpOAuthPopup.test.ts` harness) inside a `MemoryRouter`, which shares
// the declarative navigator shape the guard patches.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedGuard } from '../useUnsavedGuard';

let container: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof useNavigate> | null = null;
let currentPath = '';

function Probe({ dirty }: { dirty: boolean | (() => boolean) }) {
  useUnsavedGuard(dirty);
  navigate = useNavigate();
  currentPath = useLocation().pathname;
  return null;
}

function mount(dirty: boolean | (() => boolean)): void {
  act(() => {
    root.render(
      createElement(MemoryRouter, { initialEntries: ['/start'] }, createElement(Probe, { dirty })),
    );
  });
}

function go(path: string): void {
  act(() => {
    navigate?.(path);
  });
}

beforeEach(() => {
  navigate = null;
  currentPath = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('useUnsavedGuard — in-app navigation', () => {
  it('lets navigation through when clean, without prompting', () => {
    const confirm = vi.spyOn(window, 'confirm');
    mount(false);
    go('/next');
    expect(currentPath).toBe('/next');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('blocks navigation when dirty and the user declines', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(true);
    go('/next');
    expect(currentPath).toBe('/start');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('proceeds when dirty and the user confirms', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount(true);
    go('/next');
    expect(currentPath).toBe('/next');
  });

  it('accepts a thunk, read at navigation time (ref-backed dirty state)', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let dirtyNow = false;
    mount(() => dirtyNow);
    go('/one');
    expect(currentPath).toBe('/one');
    dirtyNow = true;
    go('/two');
    expect(currentPath).toBe('/one');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('stops guarding after unmount', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(true);
    act(() => root.unmount());
    // Re-mount clean over the same router: navigation is free again.
    root = createRoot(container);
    mount(false);
    go('/next');
    expect(currentPath).toBe('/next');
    expect(confirm).not.toHaveBeenCalled();
  });
});

// Two sibling guards on one page (Memory renders two MemoryEditor tabs, both
// mounted once visited). The old per-hook wrap/restore broke here: sibling
// cleanups run first-to-last, so A restored the original and B restored A's
// DEAD wrapper — an unmounted, dirty A then prompted on every navigation until
// reload. The fix ref-counts one shared patch per navigator.
describe('useUnsavedGuard — two sibling guards', () => {
  function GuardOnly({ dirty }: { dirty: boolean | (() => boolean) }) {
    useUnsavedGuard(dirty);
    return null;
  }

  function renderSiblings(guards: Array<boolean | (() => boolean)>): void {
    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/start'] },
          createElement(Probe, { key: 'probe', dirty: false }),
          ...guards.map((dirty, i) => createElement(GuardOnly, { key: `g${i}`, dirty })),
        ),
      );
    });
  }

  it('unmounting both siblings restores the true original — no stale prompt', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    // A dirty at unmount is the poisoned case: its dead wrapper used to stay
    // installed via B's cleanup.
    renderSiblings([true, false]);
    renderSiblings([]);
    go('/next');
    expect(currentPath).toBe('/next');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps guarding for the survivor when only one sibling unmounts', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSiblings([true, false]);
    // The clean sibling leaves; the dirty one stays and must still guard.
    renderSiblings([true]);
    go('/next');
    expect(currentPath).toBe('/start');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('both mounted and dirty: one confirm per dirty guard, any decline blocks', () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    renderSiblings([true, true]);
    go('/next');
    expect(currentPath).toBe('/start');
    expect(confirm).toHaveBeenCalledTimes(2);

    confirm.mockReturnValue(true);
    go('/next');
    expect(currentPath).toBe('/next');
  });
});

describe('useUnsavedGuard — beforeunload', () => {
  it('prevents unload while dirty', () => {
    mount(true);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not touch unload when clean', () => {
    mount(false);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
