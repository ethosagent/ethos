import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { BackgroundJob } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Plan openclaw-9.5-adoption item 6 (D29): `deliver: 'parent'` is honoured by
// the gateway only. On the web the user is already in the parent session, so a
// finished job hands its result back to that conversation the same way
// whichever `deliver` it was spawned with.

describe('web-api — job completion hand-back ignores deliver', () => {
  let dir: string;
  let store: SQLiteSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-jobdeliver-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  function job(deliver: 'user' | 'parent'): BackgroundJob {
    return {
      id: `job-${deliver}`,
      owner: 'proc-1',
      parentSessionKey: 'web:parent',
      rootSessionKey: 'web:parent',
      childSessionKey: 'web:parent:job:task:1',
      depth: 1,
      status: 'done',
      prompt: 'check the build',
      summary: 'all green',
      spendUsd: 0,
      createdAt: 0,
      deliver,
    };
  }

  it("hands a 'parent' job back exactly like a 'user' one", async () => {
    let fire: ((job: BackgroundJob) => void) | undefined;
    const agentLoop = makeStubAgentLoop();
    const { chatService } = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop,
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      subscribeJobComplete: (handler) => {
        fire = handler;
        return () => {};
      },
    });
    const handBack = vi.spyOn(chatService, 'handBack').mockResolvedValue(undefined as never);
    // The parent session's key → id mapping comes from `session_start`.
    await agentLoop.hooks.fireVoid('session_start', {
      sessionId: 'sess-parent',
      sessionKey: 'web:parent',
    } as never);

    fire?.(job('user'));
    fire?.(job('parent'));

    expect(handBack).toHaveBeenCalledTimes(2);
    const [userCall, parentCall] = handBack.mock.calls;
    expect(parentCall?.[0]).toBe('sess-parent');
    expect(parentCall?.[1]).toBe(userCall?.[1]);
  });
});
