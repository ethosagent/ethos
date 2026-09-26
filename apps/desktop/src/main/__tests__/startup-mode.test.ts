import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let wasOpenedAtLogin = false;

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ wasOpenedAtLogin }),
  },
}));

import { isBackgroundMode } from '../startup-mode';

describe('isBackgroundMode', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['electron', 'main.js'];
    wasOpenedAtLogin = false;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('is true when launched with --hidden', () => {
    process.argv = ['electron', 'main.js', '--hidden'];
    expect(isBackgroundMode()).toBe(true);
  });

  it('is true when macOS reports the app was opened at login', () => {
    wasOpenedAtLogin = true;
    expect(isBackgroundMode()).toBe(true);
  });

  it('is false for a normal launch', () => {
    expect(isBackgroundMode()).toBe(false);
  });
});
