// @vitest-environment jsdom
//
// useAttentionSignals — title prefix, favicon dot, and opt-in notifications
// driven by the merged activity stream plus the active session's stream.

import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTENTION_NOTIFY_KEY } from '../../lib/attention/notify';
import { useAttentionSignals } from '../useAttentionSignals';

const DOT = 'data:image/png;base64,DOT';

vi.mock('../../lib/attention/favicon', () => ({
  renderDotFavicon: vi.fn(async () => 'data:image/png;base64,DOT'),
  browserFaviconDeps: {},
}));

interface Handlers<T> {
  onEvent: (e: T) => void;
}
const activity = { handlers: null as Handlers<ActivityEvent> | null, close: vi.fn() };
const session = {
  handlers: null as Handlers<SseEvent> | null,
  id: null as string | null,
  close: vi.fn(),
};

vi.mock('../../sse', () => ({
  subscribeToActivity: (_p: string | null, opts: Handlers<ActivityEvent>) => {
    activity.handlers = opts;
    return { close: activity.close, lastSeq: 0, connectionState: 'open' };
  },
  subscribeToSession: (id: string, opts: Handlers<SseEvent>) => {
    session.id = id;
    session.handlers = opts;
    return { close: session.close, lastSeq: 0, connectionState: 'open' };
  },
}));

let container: HTMLDivElement;
let root: Root;
let path = '';
let icon: HTMLLinkElement;
const notifications: Array<{
  title: string;
  opts: { tag: string; body: string };
  onclick: (() => void) | null;
  close: () => void;
}> = [];

function Probe() {
  useAttentionSignals();
  const loc = useLocation();
  path = loc.pathname + loc.search;
  return null;
}

function mount(entry = '/p/coder/chat?session=s1'): void {
  act(() => {
    root.render(createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Probe)));
  });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function approvalRequired(id: string, sessionId = 's1'): ActivityEvent {
  return {
    sessionId,
    personalityId: 'coder',
    event: {
      type: 'tool.approval_required',
      request: {
        approvalId: id,
        sessionId,
        toolCallId: 't1',
        toolName: 'bash',
        args: {},
        reason: null,
        alwaysAsk: false,
        hardline: false,
      },
    },
  };
}

function approvalResolved(id: string): ActivityEvent {
  return {
    sessionId: 's1',
    personalityId: 'coder',
    event: { type: 'approval.resolved', approvalId: id, decision: 'allow', decidedBy: 'c' },
  };
}

function clarify(id: string): ActivityEvent {
  return {
    sessionId: 's1',
    personalityId: 'coder',
    event: {
      type: 'clarify.request',
      requestId: id,
      question: 'secret question',
      defaultDeadlineAt: null,
    },
  };
}

function emit(e: ActivityEvent): void {
  act(() => {
    activity.handlers?.onEvent(e);
  });
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.title = 'Ethos';
  icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = '/favicon.svg';
  icon.type = 'image/svg+xml';
  document.head.appendChild(icon);
  notifications.length = 0;
  activity.handlers = null;
  activity.close = vi.fn();
  session.handlers = null;
  session.id = null;
  session.close = vi.fn();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function stubNotification(permission: 'granted' | 'denied'): void {
  class FakeNotification {
    static permission = permission;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      public title: string,
      public opts: { tag: string; body: string },
    ) {
      notifications.push(this);
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
}

describe('useAttentionSignals', () => {
  it('hidden + approval -> title (1) and icon is the dot', async () => {
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    expect(document.title).toBe('(1) Ethos');
    expect(icon.getAttribute('href')).toBe(DOT);
  });

  it('visible tab never prefixes the title', async () => {
    mount('/settings');
    emit(approvalRequired('a1'));
    await flush();
    expect(document.title).toBe('Ethos');
    expect(icon.getAttribute('href')).toBe('/favicon.svg');
  });

  it('counts approvals and clarifies and drops one on approval.resolved', async () => {
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    emit(approvalRequired('a2'));
    emit(clarify('c1'));
    await flush();
    expect(document.title).toBe('(3) Ethos');
    emit(approvalResolved('a1'));
    expect(document.title).toBe('(2) Ethos');
  });

  it('restores title and icon when everything is resolved', async () => {
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    emit(approvalResolved('a1'));
    expect(document.title).toBe('Ethos');
    expect(icon.getAttribute('href')).toBe('/favicon.svg');
    expect(icon.getAttribute('type')).toBe('image/svg+xml');
  });

  it('a replayed approval_required does not double count', async () => {
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    emit(approvalRequired('a1'));
    await flush();
    expect(document.title).toBe('(1) Ethos');
  });

  it('becoming visible on the items chat route clears it; tombstone survives a replay', async () => {
    mount('/p/coder/chat?session=s1');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    expect(document.title).toBe('(1) Ethos');
    setVisibility('visible');
    expect(document.title).toBe('Ethos');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    expect(document.title).toBe('Ethos');
  });

  it('an item for a different session stays counted when visible and shows again after hiding', async () => {
    mount('/p/coder/chat?session=s1');
    emit(approvalRequired('a9', 'other'));
    await flush();
    expect(document.title).toBe('Ethos');
    setVisibility('hidden');
    await flush();
    expect(document.title).toBe('(1) Ethos');
  });

  it('hidden + pref on + granted -> one Notification; click navigates; pref off -> none', async () => {
    localStorage.setItem(ATTENTION_NOTIFY_KEY, 'on');
    stubNotification('granted');
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.opts.tag).toBe('approval:a1');
    act(() => notifications[0]?.onclick?.());
    expect(path).toBe('/p/coder/chat?session=s1');
  });

  it('pref off -> zero Notifications', async () => {
    stubNotification('granted');
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    expect(notifications).toHaveLength(0);
  });

  it('restores the base title captured at first signal even if the app changed it meanwhile', async () => {
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    document.title = 'Some Other Page';
    emit(approvalResolved('a1'));
    expect(document.title).toBe('Ethos');
  });

  it('credential_required from the active session stream counts', async () => {
    localStorage.setItem('ethos.lastSessionId', 's1');
    mount('/settings');
    setVisibility('hidden');
    act(() => {
      session.handlers?.onEvent({
        type: 'credential_required',
        pluginId: 'gh',
        credentialKey: 'token',
        kind: 'api_key',
        label: 'GitHub',
        pendingUserMessage: 'private',
      });
    });
    await flush();
    expect(document.title).toBe('(1) Ethos');
  });

  it('unmount restores title/favicon and closes both subscriptions', async () => {
    localStorage.setItem('ethos.lastSessionId', 's1');
    mount('/settings');
    setVisibility('hidden');
    emit(approvalRequired('a1'));
    await flush();
    act(() => root.unmount());
    expect(document.title).toBe('Ethos');
    expect(icon.getAttribute('href')).toBe('/favicon.svg');
    expect(activity.close).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
    root = createRoot(container);
  });
});
