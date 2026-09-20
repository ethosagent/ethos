import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: vi.fn().mockResolvedValue('id'),
  dismissNotificationAsync: vi.fn().mockResolvedValue(undefined),
}));

import * as Notifications from 'expo-notifications';
import {
  buildResolvedNotificationInput,
  DISMISS_AFTER_MS,
  resolvedRowText,
  scheduleResolvedNotification,
} from '../resolved-row';

const NOW = Date.parse('2026-09-19T09:41:00');

// Test case 19 (Testing §): `approval.resolved` for an approval that was
// notified (decided here, elsewhere, or by timeout) · a local notification is
// scheduled with `identifier = approvalId` — the identifier the push's
// `collapseId` carried, so it REPLACES the banner — and `threadId =
// sessionId`, with the resolved-row text, no `categoryId`, `sound: null`, no
// haptic, and a 60 s dismissal.
describe('resolvedRowText', () => {
  it('allowed once', () => {
    expect(resolvedRowText({ kind: 'allowed-once', toolName: 'bash' }, NOW)).toBe(
      '✓ allowed once · bash · 09:41',
    );
  });

  it('denied', () => {
    expect(resolvedRowText({ kind: 'denied', toolName: 'bash' }, NOW)).toBe('✗ denied · bash');
  });

  it('resolved elsewhere', () => {
    expect(resolvedRowText({ kind: 'elsewhere' }, NOW)).toBe('resolved elsewhere');
  });

  it('auto-denied', () => {
    expect(resolvedRowText({ kind: 'auto-denied' }, NOW)).toBe('✗ auto-denied at 09:41');
  });
});

describe('buildResolvedNotificationInput', () => {
  it('replaces the banner by identifier, groups by threadIdentifier, and carries no actions or sound', () => {
    const req = buildResolvedNotificationInput(
      'a1',
      's1',
      { kind: 'allowed-once', toolName: 'bash' },
      NOW,
    );
    expect(req.identifier).toBe('a1');
    expect(req.content.body).toBe('✓ allowed once · bash · 09:41');
    expect((req.content as { threadIdentifier?: string }).threadIdentifier).toBe('s1');
    expect(req.content.categoryIdentifier).toBeUndefined();
    expect(req.content.sound).toBe(false);
    expect(req.trigger).toBeNull();
  });
});

describe('scheduleResolvedNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules the replacement immediately, identified by the approvalId', async () => {
    await scheduleResolvedNotification('a2', 's2', { kind: 'denied', toolName: 'git' }, NOW);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'a2' }),
    );
  });

  it('does not dismiss before 60s', async () => {
    await scheduleResolvedNotification('a2', 's2', { kind: 'denied', toolName: 'git' }, NOW);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('auto-dismisses after 60s', async () => {
    await scheduleResolvedNotification('a2', 's2', { kind: 'denied', toolName: 'git' }, NOW);
    await vi.advanceTimersByTimeAsync(DISMISS_AFTER_MS);
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('a2');
  });
});
