// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '../attention-state';
import {
  ATTENTION_NOTIFY_KEY,
  buildAttentionNotification,
  enableAttentionNotifications,
  getAttentionNotifyPref,
  notificationSupport,
  setAttentionNotifyPref,
  showAttentionNotification,
} from '../notify';

const approval: AttentionItem = {
  key: 'approval:a1',
  kind: 'approval',
  sessionId: 's1',
  personalityId: 'p1',
  detail: 'bash',
};

interface FakeNotification {
  tag: string | undefined;
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

function stubNotification(permission: string, requestResult = permission) {
  const instances: FakeNotification[] = [];
  const requestPermission = vi.fn(async () => requestResult);
  class Fake {
    static permission = permission;
    static requestPermission = requestPermission;
    tag: string | undefined;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      public title: string,
      opts?: { body?: string; tag?: string },
    ) {
      this.tag = opts?.tag;
      instances.push(this);
    }
  }
  vi.stubGlobal('Notification', Fake);
  return { instances, requestPermission };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notify preference', () => {
  it('defaults to false', () => {
    expect(getAttentionNotifyPref()).toBe(false);
  });

  it('set true then get true', () => {
    expect(setAttentionNotifyPref(true)).toBe(true);
    expect(localStorage.getItem(ATTENTION_NOTIFY_KEY)).toBe('on');
    expect(getAttentionNotifyPref()).toBe(true);
    setAttentionNotifyPref(false);
    expect(getAttentionNotifyPref()).toBe(false);
  });

  it('treats an invalid stored value as false', () => {
    localStorage.setItem(ATTENTION_NOTIFY_KEY, 'banana');
    expect(getAttentionNotifyPref()).toBe(false);
  });

  it('survives getItem throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getAttentionNotifyPref()).toBe(false);
  });

  it('returns false when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(setAttentionNotifyPref(true)).toBe(false);
  });
});

describe('notificationSupport', () => {
  it('is unsupported when Notification is undefined', () => {
    vi.stubGlobal('Notification', undefined);
    expect(notificationSupport()).toBe('unsupported');
  });

  it('mirrors Notification.permission', () => {
    stubNotification('denied');
    expect(notificationSupport()).toBe('denied');
    stubNotification('granted');
    expect(notificationSupport()).toBe('granted');
    stubNotification('default');
    expect(notificationSupport()).toBe('default');
  });
});

describe('enableAttentionNotifications', () => {
  it('stores on when granted', async () => {
    const { requestPermission } = stubNotification('default', 'granted');
    expect(await enableAttentionNotifications()).toBe('granted');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(localStorage.getItem(ATTENTION_NOTIFY_KEY)).toBe('on');
  });

  it('does not store when denied', async () => {
    stubNotification('default', 'denied');
    expect(await enableAttentionNotifications()).toBe('denied');
    expect(localStorage.getItem(ATTENTION_NOTIFY_KEY)).toBeNull();
  });

  it('returns unsupported without throwing', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(await enableAttentionNotifications()).toBe('unsupported');
  });
});

describe('showAttentionNotification', () => {
  it('constructs nothing and never prompts when permission is denied', () => {
    const { instances, requestPermission } = stubNotification('denied');
    setAttentionNotifyPref(true);
    showAttentionNotification(approval, vi.fn());
    expect(instances).toHaveLength(0);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is a no-op when the pref is off', () => {
    const { instances } = stubNotification('granted');
    showAttentionNotification(approval, vi.fn());
    expect(instances).toHaveLength(0);
  });

  it('constructs one tagged notification whose click focuses, opens and closes', () => {
    const { instances } = stubNotification('granted');
    setAttentionNotifyPref(true);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const onOpen = vi.fn();
    showAttentionNotification(approval, onOpen);
    expect(instances).toHaveLength(1);
    const n = instances[0];
    expect(n?.tag).toBe('approval:a1');
    n?.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(approval);
    expect(n?.close).toHaveBeenCalled();
  });
});

describe('buildAttentionNotification', () => {
  it('names the tool for approvals', () => {
    const spec = buildAttentionNotification(approval);
    expect(spec).toEqual({
      title: 'Ethos needs you',
      body: 'Approval needed: bash',
      tag: 'approval:a1',
    });
  });

  it('builds clarify and credential bodies only from kind and detail', () => {
    const clarify = buildAttentionNotification({
      key: 'clarify:c1',
      kind: 'clarify',
      sessionId: 's',
      personalityId: null,
      detail: 'question',
    });
    expect(clarify.body).toBe('Question waiting');
    const cred = buildAttentionNotification({
      key: 'credential:s:gh:t',
      kind: 'credential',
      sessionId: 's',
      personalityId: null,
      detail: 'GitHub token',
    });
    expect(cred.body).toBe('Credential needed: GitHub token');
  });
});
