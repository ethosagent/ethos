import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chat paths that run while the server is unreachable, through the real
// SDK client: a phone reaching a server bound to 127.0.0.1 gets "Could not
// connect to the server" from every fetch. Each path here is fired and
// forgotten by its caller (AppState listener, list scroll, composer), so a
// rejection that escapes it is unhandled — under Expo Go, a full-screen error.
// The contract is a resolved row instead (§11).

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { makeClient, streams } from '../../../api/client';
import { useChatStore } from '../../../state/chat-store';
import { useConnection } from '../../../state/connection';
import { adoptSession, foreground, loadOlder } from '../session';

const URL = 'http://192.168.1.20:3000';
const KEY = 'sk-ethos-test';

let leaked: unknown[] = [];
const collect = (reason: unknown) => leaked.push(reason);
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  leaked = [];
  process.on('unhandledRejection', collect);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Could not connect to the server');
    }),
  );
  useConnection.setState({ url: URL, key: KEY, client: makeClient(URL, KEY) });
  useChatStore.getState().reset('s1');
});

afterEach(() => {
  streams.closeAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.off('unhandledRejection', collect);
});

const rpc = () => {
  const client = useConnection.getState().client;
  if (!client) throw new Error('no client');
  return client.rpc;
};

const refusedRow = (subject: string) =>
  expect.objectContaining({
    glyph: '✗',
    subject,
    result: expect.stringMatching(/Could not connect to the server/),
  });

describe('an unreachable server leaves a row, never an unhandled rejection', () => {
  it('foreground after ≥ 60 s: the failed rehydrate is a row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await foreground.onAppState('background');
    vi.setSystemTime(Date.now() + 90_000);
    // `app/_layout.tsx` fires this and forgets it.
    void foreground.onAppState('active');
    await settle();
    expect(leaked).toEqual([]);
    expect(useChatStore.getState().notices).toEqual([refusedRow('sessions.messages')]);
  });

  it('scroll-up: the failed older page is a row, and the cursor comes back', async () => {
    useChatStore.setState({ olderCursor: 'c1' });
    void loadOlder(rpc());
    await settle();
    expect(leaked).toEqual([]);
    expect(useChatStore.getState().olderCursor).toBe('c1');
    expect(useChatStore.getState().notices).toEqual([refusedRow('sessions.messages')]);
  });

  it('a new session adopted after the server went away: sessions.get is a row', async () => {
    useChatStore.getState().reset(null);
    void adoptSession(rpc(), 's2');
    await settle();
    expect(leaked).toEqual([]);
    expect(useChatStore.getState().sessionId).toBe('s2');
    expect(useChatStore.getState().notices).toEqual([refusedRow('sessions.get')]);
  });
});
