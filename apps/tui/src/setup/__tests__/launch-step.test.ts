import { describe, expect, it } from 'vitest';
import { launchOptions } from '../steps/launch-options';

// W2.5 — the LaunchStep three-way close. The gateway option is gated on a
// channel having validated during setup; the pure `launchOptions` helper owns
// that gating so it can be tested without an Ink render.

describe('launchOptions — W2.5 three-way close', () => {
  it('offers all three options when a channel validated', () => {
    const ids = launchOptions(true).map((o) => o.id);
    expect(ids).toEqual(['gateway', 'chat', 'done']);
  });

  it('hides the gateway option when no channel validated', () => {
    const ids = launchOptions(false).map((o) => o.id);
    expect(ids).toEqual(['chat', 'done']);
    expect(ids).not.toContain('gateway');
  });

  it('always offers chat and done', () => {
    for (const hasChannel of [true, false]) {
      const ids = launchOptions(hasChannel).map((o) => o.id);
      expect(ids).toContain('chat');
      expect(ids).toContain('done');
    }
  });

  it('labels the gateway option for Telegram', () => {
    const gateway = launchOptions(true).find((o) => o.id === 'gateway');
    expect(gateway?.label).toBe('Start the Telegram bot now');
  });
});
