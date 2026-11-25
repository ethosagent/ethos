// `/communications?tab=<platform>` picks the tab (plan/phases/channel-prompts-ui.md
// L5 deep link). The onboarding link points here, so a typo'd or stale tab must
// land on a real tab, never a blank page.

import { describe, expect, it } from 'vitest';
import {
  COMMUNICATIONS_DEFAULT_TAB,
  resolveCommunicationsTab,
} from '../../features/communications/tab-param';

const KEYS = ['telegram', 'slack', 'whatsapp', 'calls', 'discord', 'email'];

describe('resolveCommunicationsTab', () => {
  it('opens the named tab', () => {
    expect(resolveCommunicationsTab('slack', KEYS)).toBe('slack');
    expect(resolveCommunicationsTab('discord', KEYS)).toBe('discord');
    expect(resolveCommunicationsTab('whatsapp', KEYS)).toBe('whatsapp');
  });

  it('falls back to Telegram for an unknown or missing tab', () => {
    expect(COMMUNICATIONS_DEFAULT_TAB).toBe('telegram');
    expect(resolveCommunicationsTab('nope', KEYS)).toBe('telegram');
    expect(resolveCommunicationsTab('', KEYS)).toBe('telegram');
    expect(resolveCommunicationsTab(null, KEYS)).toBe('telegram');
    expect(resolveCommunicationsTab('__proto__', KEYS)).toBe('telegram');
  });
});
