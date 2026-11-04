import { InMemorySessionStore } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { runBranchCommand } from '../session-branches';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

async function seeded() {
  const store = new InMemorySessionStore();
  const root = await store.createSession({
    key: 'cli:proj',
    platform: 'cli',
    model: 'm',
    provider: 'p',
    personalityId: 'researcher',
    usage,
  });
  await store.appendMessage({ sessionId: root.id, role: 'user', content: 'hi' });
  await store.appendMessage({ sessionId: root.id, role: 'assistant', content: 'hello' });
  return { store, root };
}

describe('runBranchCommand (CLI/TUI /fork, /branches, /branch)', () => {
  it('/fork re-keys onto a cli:<cwd>:fork:<ts>-<suffix> child carrying the history', async () => {
    const { store, root } = await seeded();
    const out = await runBranchCommand(store, 'fork', '', 'cli:proj', '/work/proj');
    const key = out.switchTo?.sessionKey ?? '';
    expect(key).toMatch(/^cli:proj:fork:\d+-[0-9a-f]{8}$/);
    expect(out.switchTo?.personalityId).toBe('researcher');
    const fork = await store.getSessionByKey(key);
    expect(fork?.parentSessionId).toBe(root.id);
    expect((await store.getMessages(fork?.id ?? '')).map((m) => m.content)).toEqual([
      'hi',
      'hello',
    ]);
  });

  it('/branches numbers origin then forks, marking the current one; /branch <n> switches', async () => {
    const { store } = await seeded();
    const forked = await runBranchCommand(store, 'fork', '', 'cli:proj', '/work/proj');
    const forkKey = forked.switchTo?.sessionKey ?? '';

    const listed = await runBranchCommand(store, 'branches', '', forkKey);
    expect(listed.message).toContain('  1. origin — cli:proj');
    expect(listed.message).toContain(`* 2. fork — ${forkKey}`);

    const back = await runBranchCommand(store, 'branch', '1', forkKey);
    expect(back.switchTo?.sessionKey).toBe('cli:proj');
    expect((await runBranchCommand(store, 'branch', '1', 'cli:proj')).message).toBe(
      'Already on branch 1.',
    );
  });

  it('/branch out of range or non-numeric answers with usage and does not switch', async () => {
    const { store } = await seeded();
    await runBranchCommand(store, 'fork', '', 'cli:proj', '/work/proj');
    for (const arg of ['', '0', '3', 'x', '1.5']) {
      const out = await runBranchCommand(store, 'branch', arg, 'cli:proj');
      expect(out.switchTo).toBeUndefined();
      expect(out.message).toMatch(/^Usage: \/branch <n>.*\(1-2\)$/);
    }
  });

  it('refuses to branch a session that does not exist yet', async () => {
    const store = new InMemorySessionStore();
    const out = await runBranchCommand(store, 'fork', '', 'cli:empty');
    expect(out.switchTo).toBeUndefined();
    expect(out.message).toMatch(/send a message first/);
  });
});

describe('runBranchCommand while incognito', () => {
  async function incognitoSeeded(childIncognito: boolean) {
    const store = new InMemorySessionStore();
    const root = await store.createSession({
      key: 'cli:proj',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      personalityId: 'researcher',
      usage,
      metadata: { incognito: true, roomAudience: 'shared' },
    });
    await store.appendMessage({ sessionId: root.id, role: 'user', content: 'hi' });
    await store.createSession({
      key: 'cli:proj:fork:1-aaaaaaaa',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      personalityId: 'researcher',
      usage,
      parentSessionId: root.id,
      ...(childIncognito ? { metadata: { incognito: true, roomAudience: 'shared' } } : {}),
    });
    return store;
  }

  it('refuses to switch onto a normal branch', async () => {
    const out = await runBranchCommand(await incognitoSeeded(false), 'branch', '2', 'cli:proj');
    expect(out.switchTo).toBeUndefined();
    expect(out.message).toBe('That branch is not incognito. Send /new to leave incognito first.');
  });

  it('switches onto an incognito branch', async () => {
    const out = await runBranchCommand(await incognitoSeeded(true), 'branch', '2', 'cli:proj');
    expect(out.switchTo?.sessionKey).toBe('cli:proj:fork:1-aaaaaaaa');
  });

  it('a fork of an incognito session is allowed (and stays incognito)', async () => {
    const store = await incognitoSeeded(true);
    const out = await runBranchCommand(store, 'fork', '', 'cli:proj', '/work/proj');
    const fork = await store.getSessionByKey(out.switchTo?.sessionKey ?? '');
    expect(fork?.metadata?.incognito).toBe(true);
  });
});
