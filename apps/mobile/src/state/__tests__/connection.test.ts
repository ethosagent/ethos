import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The connection store's three fire-and-forget entry points (launch,
// Connect, Disconnect / UNAUTHORIZED). Each is started without an await by
// its caller, so none may reject — under Expo Go an unhandled rejection is a
// full-screen error.

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
import { useConnection } from '../connection';

let leaked: unknown[] = [];
const collect = (reason: unknown) => leaked.push(reason);

beforeEach(() => {
  leaked = [];
  process.on('unhandledRejection', collect);
  useConnection.setState({ loaded: false, url: null, key: null, client: null });
});
afterEach(() => {
  process.off('unhandledRejection', collect);
  vi.mocked(getItemAsync).mockReset();
  vi.mocked(setItemAsync).mockReset();
  vi.mocked(deleteItemAsync).mockReset();
});

describe('connection store never rejects', () => {
  it('launch with a saved connection restores it and builds a client', async () => {
    vi.mocked(getItemAsync).mockImplementation(async (item: string) =>
      item === 'ethos.server-url' ? 'http://192.168.1.20:3000' : 'sk-ethos-test',
    );
    await useConnection.getState().hydrate();
    const s = useConnection.getState();
    expect(s.loaded).toBe(true);
    expect(s.key).toBe('sk-ethos-test');
    expect(s.client).not.toBeNull();
  });

  it('launch with an unreadable Keychain lands on Connect', async () => {
    vi.mocked(getItemAsync).mockRejectedValue(new Error('User interaction is not allowed'));
    await expect(useConnection.getState().hydrate()).resolves.toBeUndefined();
    const s = useConnection.getState();
    expect(s.loaded).toBe(true);
    expect(s.key).toBeNull();
    expect(s.client).toBeNull();
    expect(leaked).toEqual([]);
  });

  it('a Keychain write that fails on Connect is a row, and nothing is adopted', async () => {
    vi.mocked(setItemAsync).mockRejectedValue(new Error('errSecInteractionNotAllowed'));
    const row = await useConnection.getState().connect('http://192.168.1.20:3000', 'sk-ethos-x');
    expect(row).toEqual(
      expect.objectContaining({
        glyph: '✗',
        subject: 'keychain',
        result: 'errSecInteractionNotAllowed',
      }),
    );
    expect(useConnection.getState().client).toBeNull();
    expect(leaked).toEqual([]);
  });

  it('Connect adopts the connection when the Keychain write lands', async () => {
    vi.mocked(setItemAsync).mockResolvedValue(undefined);
    const row = await useConnection.getState().connect('http://192.168.1.20:3000', 'sk-ethos-x');
    expect(row).toBeNull();
    expect(useConnection.getState().client).not.toBeNull();
  });

  it('Disconnect forgets the key even when the Keychain delete fails', async () => {
    useConnection.setState({ url: 'http://192.168.1.20:3000', key: 'sk-ethos-x' });
    vi.mocked(deleteItemAsync).mockRejectedValue(new Error('keychain locked'));
    await expect(useConnection.getState().disconnect()).resolves.toBeUndefined();
    expect(useConnection.getState().key).toBeNull();
    expect(useConnection.getState().url).toBe('http://192.168.1.20:3000');
    expect(leaked).toEqual([]);
  });
});
