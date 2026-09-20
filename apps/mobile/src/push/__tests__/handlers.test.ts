import type { EthosClient } from '@ethosagent/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn().mockResolvedValue(null),
  scheduleNotificationAsync: vi.fn().mockResolvedValue('id'),
  dismissNotificationAsync: vi.fn().mockResolvedValue(undefined),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));

// `../../state/connection` pulls in `../auth/keychain` (expo-secure-store);
// the real package drags in react-native's flow-typed entry point, which
// vitest's plain (non-Metro) transform cannot parse (offline-send.test.ts
// mocks it for the same reason).
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

// The real package pulls in react-native's flow-typed entry point too (same
// reason as expo-secure-store above); only the imperative `navigate` is used.
// `vi.hoisted` because `vi.mock` factories are hoisted above this file's own
// top-level `const`s.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('expo-router', () => ({ router: { navigate } }));

import * as Notifications from 'expo-notifications';
import { useConnection } from '../../state/connection';
import { registerNotificationResponseHandler, routeColdStartNotification } from '../handlers';

type Listener = (response: {
  actionIdentifier: string;
  notification: {
    request: {
      identifier: string;
      content: {
        body: string | null;
        data?: Record<string, unknown>;
        threadIdentifier: string | null;
      };
    };
  };
}) => void;

function capturedListener(): Listener {
  return vi.mocked(Notifications.addNotificationResponseReceivedListener).mock
    .calls[0]?.[0] as Listener;
}

// A distinct default per call, not a fixed constant — the dedup guard in
// `handlers.ts` keys off this id and is module-level state, so two responses
// that don't ask for the same id must not collide across `it`s in this file.
let nextNotificationId = 0;

function response(overrides: {
  actionIdentifier: string;
  body?: string;
  data?: Record<string, unknown>;
  threadIdentifier?: string;
  identifier?: string;
}) {
  return {
    actionIdentifier: overrides.actionIdentifier,
    notification: {
      request: {
        identifier: overrides.identifier ?? `n${nextNotificationId++}`,
        content: {
          body: overrides.body ?? null,
          data: overrides.data,
          threadIdentifier: overrides.threadIdentifier ?? null,
        },
      },
    },
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('registerNotificationResponseHandler', () => {
  let approve: ReturnType<typeof vi.fn>;
  let deny: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(Notifications.addNotificationResponseReceivedListener).mockImplementation(
      () =>
        ({ remove: vi.fn() }) as unknown as ReturnType<
          typeof Notifications.addNotificationResponseReceivedListener
        >,
    );
    approve = vi.fn().mockResolvedValue({ ok: true });
    deny = vi.fn().mockResolvedValue({ ok: true });
    useConnection.setState({
      client: {
        rpc: { tools: { approve, deny } },
      } as unknown as EthosClient,
    });
    registerNotificationResponseHandler();
  });

  afterEach(() => {
    vi.useRealTimers();
    useConnection.setState({ client: null });
  });

  it('Allow once calls tools.approve with scope "once" and schedules the resolved row', async () => {
    capturedListener()(
      response({
        actionIdentifier: 'allow-once',
        body: 'Wants to run bash · Open to review',
        data: { category: 'approvals', approvalId: 'a1' },
        threadIdentifier: 's1',
      }),
    );
    await flush();
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'a1', scope: 'once' }),
    );
    expect(deny).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'a1',
        content: expect.objectContaining({
          body: expect.stringContaining('✓ allowed once · bash'),
        }),
      }),
    );
  });

  it('Deny calls tools.deny and schedules the resolved row', async () => {
    capturedListener()(
      response({
        actionIdentifier: 'deny',
        body: 'Wants to run git · Open to review',
        data: { category: 'approvals', approvalId: 'a2' },
        threadIdentifier: 's2',
      }),
    );
    await flush();
    expect(deny).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'a2' }));
    expect(approve).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'a2',
        content: expect.objectContaining({ body: '✗ denied · git' }),
      }),
    );
  });

  // D11 deviation: a clarify push carries no actions (`../categories`), so any
  // response to one is a no-op here — the notification's default tap opens
  // the app, where the real options are rendered and answered.
  it('a clarify notification response is a no-op', async () => {
    capturedListener()(
      response({
        actionIdentifier: 'option-1',
        data: { category: 'clarify', clarifyId: 'c1' },
        threadIdentifier: 's3',
      }),
    );
    await flush();
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a `test-` approvalId (push.test fixture) resolves locally, never calling the server', async () => {
    capturedListener()(
      response({
        actionIdentifier: 'allow-once',
        body: 'Wants to run bash · Open to review',
        data: { category: 'approvals', approvalId: 'test-abc', test: true },
        threadIdentifier: 'push-test',
      }),
    );
    await flush();
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'test-abc',
        content: expect.objectContaining({
          body: expect.stringContaining('✓ allowed once · bash'),
        }),
      }),
    );
  });

  it('a plain tap never calls approve/deny, only a real action identifier does', async () => {
    capturedListener()(
      response({
        actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
        body: 'Wants to run bash · Open to review',
        data: { category: 'approvals', approvalId: 'a3' },
      }),
    );
    await flush();
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a plain tap on an approval navigates to the session it belongs to', () => {
    capturedListener()(
      response({
        actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
        data: { category: 'approvals', approvalId: 'a5', deepLink: 'ethos://p/engineer/chat' },
        threadIdentifier: 's5',
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/chat/s5');
  });

  it('a plain tap on a cron failure navigates to Activity', () => {
    capturedListener()(
      response({
        actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
        data: { category: 'cronFailures', jobId: 'j1' },
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/activity');
  });

  it('a plain tap with no recognizable category does not navigate', () => {
    capturedListener()(
      response({ actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER, data: {} }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not double-navigate when the cold-start check already routed the same notification', async () => {
    const r = response({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      data: { category: 'cronFailures' },
      identifier: 'cold-1',
    });
    vi.mocked(Notifications.getLastNotificationResponseAsync).mockResolvedValueOnce(
      r as unknown as Notifications.NotificationResponse,
    );
    await routeColdStartNotification();
    expect(navigate).toHaveBeenCalledTimes(1);
    capturedListener()(r);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
