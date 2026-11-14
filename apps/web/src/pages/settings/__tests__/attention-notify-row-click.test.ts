// @vitest-environment jsdom
//
// AttentionNotifyRow click handler: permission is requested only on click, the
// Switch reflects the real stored state, and a failed localStorage write is
// surfaced instead of silently leaving notifications on.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTENTION_NOTIFY_KEY } from '../../../lib/attention/notify';
import { AttentionNotifyRow } from '../panes/attention-notify-row';

let container: HTMLDivElement;
let root: Root;
const requestPermission = vi.fn();

function stubNotification(permission: 'granted' | 'default'): void {
  requestPermission.mockImplementation(async () => 'granted');
  vi.stubGlobal('Notification', { permission, requestPermission });
}

function mount(): void {
  act(() => {
    root.render(createElement(AttentionNotifyRow));
  });
}

function switchEl(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!el) throw new Error('switch not found');
  return el;
}

async function click(): Promise<void> {
  await act(async () => {
    switchEl().click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  requestPermission.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AttentionNotifyRow click handler', () => {
  it('requests permission only on click, then stores on', async () => {
    stubNotification('default');
    mount();
    expect(requestPermission).not.toHaveBeenCalled();
    await click();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ATTENTION_NOTIFY_KEY)).toBe('on');
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
  });

  it('disable stores off without asking permission', async () => {
    stubNotification('granted');
    localStorage.setItem(ATTENTION_NOTIFY_KEY, 'on');
    mount();
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    await click();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(localStorage.getItem(ATTENTION_NOTIFY_KEY)).toBe('off');
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
  });

  it('a failed write on disable keeps the switch on and shows an error', async () => {
    stubNotification('granted');
    localStorage.setItem(ATTENTION_NOTIFY_KEY, 'on');
    mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await click();
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('Could not save');
  });

  it('a failed write on enable leaves the switch off and shows an error', async () => {
    stubNotification('default');
    mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await click();
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('Could not save');
  });
});
