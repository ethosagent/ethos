import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// memory-experience §3.3 — a proactive capture completes AFTER the turn's chat
// stream closes, so web-api broadcasts it as a `memory.captured` push event
// scoped to the capturing session. These tests pin the wiring: the registered
// listener broadcasts on the right sessionId, and `display.memory_notices=false`
// (memoryNoticesEnabled: false) suppresses the whole subscription.

describe('web-api — memory.captured broadcast', () => {
  let dir: string;
  let store: SQLiteSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-memcap-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  function build(memoryNoticesEnabled: boolean) {
    let captured:
      | ((n: { sessionId: string; scopeId: string; summary: string }) => void)
      | undefined;
    const { chatService } = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      memoryNoticesEnabled,
      onMemoryCaptured: (cb) => {
        captured = cb;
        return () => {
          captured = undefined;
        };
      },
    });
    return { chatService, getCaptured: () => captured };
  }

  it('broadcasts memory.captured to the capturing session when enabled', () => {
    const { chatService, getCaptured } = build(true);
    const spy = vi.spyOn(chatService, 'broadcast');

    const fire = getCaptured();
    expect(fire).toBeDefined();
    fire?.({ sessionId: 'sess-1', scopeId: 'personality:researcher', summary: 'likes green tea' });

    expect(spy).toHaveBeenCalledWith('sess-1', {
      type: 'memory.captured',
      summary: 'likes green tea',
    });
  });

  it('does not subscribe when memory notices are disabled', () => {
    const { getCaptured } = build(false);
    // The listener is never registered, so the fake onMemoryCaptured is never
    // invoked — no callback is captured, hence nothing can broadcast.
    expect(getCaptured()).toBeUndefined();
  });
});
