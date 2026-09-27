import { describe, expect, it } from 'vitest';
import {
  MIN_SERVER_VERSION,
  missingOptionalScopes,
  missingScopes,
  versionAtLeast,
} from '../scopes';

describe('versionAtLeast', () => {
  it('accepts a source build with no numeric version', () => {
    expect(versionAtLeast('dev', MIN_SERVER_VERSION)).toBe(true);
  });

  it('accepts the floor itself', () => {
    expect(versionAtLeast('0.8.1', MIN_SERVER_VERSION)).toBe(true);
  });

  it('accepts a newer release', () => {
    expect(versionAtLeast('0.9.0', MIN_SERVER_VERSION)).toBe(true);
  });

  it('refuses an older release', () => {
    expect(versionAtLeast('0.8.0', MIN_SERVER_VERSION)).toBe(false);
  });

  it('ignores a pre-release suffix on an otherwise-sufficient version', () => {
    expect(versionAtLeast('0.8.1-rc.1', MIN_SERVER_VERSION)).toBe(true);
  });

  it('compares numerically, not lexically', () => {
    expect(versionAtLeast('0.10.0', MIN_SERVER_VERSION)).toBe(true);
  });
});

describe('missingScopes', () => {
  it('is empty when every required scope is granted', () => {
    expect(
      missingScopes([
        'sessions:read',
        'sessions:write',
        'chat:send',
        'personalities:read',
        'tools:approve',
        'activity:read',
        'events:subscribe',
        'push:register',
        'kanban:read',
        'kanban:write',
        'teams:read',
        'cron:read',
      ]),
    ).toEqual([]);
  });

  it('lists what is missing', () => {
    expect(missingScopes(['chat:send'])).toContain('sessions:read');
  });

  it('does not require voice:talk — a phone key minted before Phase 3 still connects', () => {
    expect(missingScopes([])).not.toContain('voice:talk');
  });
});

describe('missingOptionalScopes', () => {
  it('names the optional scopes a key lacks, and the screen each feeds', () => {
    expect(missingOptionalScopes(['memory:read', 'voice:talk']).map((m) => m.scope)).toEqual([
      'memory:write',
    ]);
    expect(missingOptionalScopes(['memory:read', 'memory:write', 'voice:talk'])).toEqual([]);
    expect(missingOptionalScopes(['memory:read', 'memory:write'])).toEqual([
      { scope: 'voice:talk', screen: 'Chat · Call' },
    ]);
  });

  it('never overlaps the required set — a required scope cannot be optional', () => {
    const optional = missingOptionalScopes([]).map((m) => m.scope);
    expect(optional.filter((s) => missingScopes([]).includes(s))).toEqual([]);
  });
});
