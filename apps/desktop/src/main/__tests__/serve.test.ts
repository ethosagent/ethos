import { describe, expect, it, vi } from 'vitest';

// Mock electron-store before importing serve (store.ts depends on it)
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string) {
      return undefined;
    }
  },
}));

// Mock keychain (depends on Electron safeStorage)
vi.mock('../keychain', () => ({
  getKeychainValue: vi.fn().mockResolvedValue(null),
}));

import { getPort } from '../serve';

describe('serve', () => {
  it('getPort returns null when no server is running', () => {
    expect(getPort()).toBeNull();
  });
});
