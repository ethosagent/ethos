import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultNotificationRouter } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Gap 10 web — createWebApi registers a per-session notification adapter on
// the wiring's NotificationRouter when a turn starts (`session_start` hook),
// so `process_complete` notifications reach the session's SSE stream as a
// `notification` event.

describe('createWebApi — notification adapter (Gap 10)', () => {
  let dir: string;
  let store: SQLiteSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-notify-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a notification keyed by sessionKey into the session SSE buffer', async () => {
    const router = new DefaultNotificationRouter();
    const loop = makeStubAgentLoop();
    const { chatService } = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: loop,
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      notificationRouter: router,
    });

    // Start a turn so a session row (id + key) exists.
    const { sessionId } = await chatService.send({ clientId: 'tab-1', text: 'hi' });
    const session = await store.getSession(sessionId);
    expect(session).not.toBeNull();
    const sessionKey = session?.key ?? '';

    // The stub loop never fires hooks itself — drive session_start the way
    // AgentLoop does (step 2 of the turn cycle).
    await loop.hooks.fireVoid('session_start', {
      sessionId,
      sessionKey,
      platform: 'web',
    });

    // A process_complete-style notification routed by sessionKey...
    await router.route('process_complete', {
      sessionKey,
      message: 'Process `abc` complete (3s)',
    });

    // ...lands in the session's SSE buffer as a `notification` event.
    const events: SseEvent[] = [];
    const unsubscribe = chatService.subscribe(sessionId, 0, (e) => events.push(e.event));
    unsubscribe();
    expect(events).toContainEqual({
      type: 'notification',
      message: 'Process `abc` complete (3s)',
    });
  });

  it('deregisters the adapter when the session buffer reaps', async () => {
    vi.useFakeTimers();
    try {
      const router = new DefaultNotificationRouter();
      const loop = makeStubAgentLoop();
      const { chatService } = createWebApi({
        dataDir: dir,
        sessionStore: store,
        memoryProvider: makeStubMemoryProvider(),
        agentLoop: loop,
        personalities: makeStubPersonalityRegistry(),
        chatDefaults: { model: 'claude-test', provider: 'anthropic' },
        notificationRouter: router,
      });

      const { sessionId } = await chatService.send({ clientId: 'tab-1', text: 'hi' });
      const session = await store.getSession(sessionId);
      const sessionKey = session?.key ?? '';
      await loop.hooks.fireVoid('session_start', { sessionId, sessionKey, platform: 'web' });

      // Disconnect the last subscriber → the buffer's reap timer (default
      // 5 min) fires onReap, which must deregister the router adapter.
      const unsubscribe = chatService.subscribe(sessionId, 0, () => {});
      unsubscribe();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Routing after reap is a silent no-op — no broadcast reaches the service.
      const broadcastSpy = vi.spyOn(chatService, 'broadcast');
      await router.route('process_complete', { sessionKey, message: 'late note' });
      expect(broadcastSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
