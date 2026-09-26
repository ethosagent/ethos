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
