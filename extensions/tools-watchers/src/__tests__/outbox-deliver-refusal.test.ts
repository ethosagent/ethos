// O-T12 (plan/phases/trust-before-reach.md) — a watcher cannot be the way out.
//
// `watcher_create` with a `deliver` target sends the change summary verbatim to
// any chat the agent names, with no LLM turn and no reviewer. For a personality
// whose publications need approval, that is the gate's back door — so the
// watcher is refused at creation and the agent is pointed at `wake`, where the
// woken turn's `send_message` is gated instead.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { WatcherManager } from '@ethosagent/watchers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWatcherTools, type WatcherOutboxGate } from '../index';

const GATE: WatcherOutboxGate = {
  gates: (personalityId, platform) => personalityId === 'cmo' && platform === 'telegram',
  ownerTarget: (platform) => (platform === 'telegram' ? '4242' : undefined),
};

function ctx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'telegram:marketing-bot:C9',
    platform: 'telegram',
    personalityId: 'cmo',
    origin: 'telegram:C9',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...partial,
  } as ToolContext;
}

let manager: WatcherManager;

function create(args: Record<string, unknown>, turn: ToolContext, gate = GATE) {
  const tool = createWatcherTools(manager, { outbox: gate }).find(
    (t) => t.name === 'watcher_create',
  );
  if (!tool) throw new Error('watcher_create not registered');
  return tool.execute(args, turn);
}

const baseArgs = {
  id: 'pricing-page',
  kind: 'http',
  target: 'https://example.com/pricing',
  interval_seconds: 300,
};

beforeEach(() => {
  manager = new WatcherManager({
    storage: new InMemoryStorage(),
    watchersDir: '/ethos/watchers',
  });
});

describe('watcher_create — gated personalities', () => {
  it('refuses a foreign deliver target and names wake', async () => {
    const result = await create(
      { ...baseArgs, deliver: { platform: 'telegram', chat_id: '-100777' } },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('telegram:-100777');
    expect(result.error).toContain('wake');
    expect(await manager.listWatchers()).toHaveLength(0);
  });

  it('allows a deliver back to the turn’s own chat', async () => {
    const result = await create(
      { ...baseArgs, deliver: { platform: 'telegram', chat_id: 'C9' } },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(await manager.listWatchers()).toHaveLength(1);
  });

  it('allows a deliver to the operator’s own chat', async () => {
    const result = await create(
      { ...baseArgs, deliver: { platform: 'telegram', chat_id: '4242' } },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(await manager.listWatchers()).toHaveLength(1);
  });

  it('allows a platform the policy does not cover', async () => {
    const result = await create(
      { ...baseArgs, deliver: { platform: 'slack', chat_id: 'C-ANNOUNCE' } },
      ctx(),
    );

    expect(result.ok).toBe(true);
  });

  it('allows wake, which is what the refusal points at', async () => {
    const result = await create({ ...baseArgs, wake: { personality_id: 'cmo' } }, ctx());

    expect(result.ok).toBe(true);
  });

  it('leaves an ungated personality unchanged', async () => {
    const result = await create(
      { ...baseArgs, deliver: { platform: 'telegram', chat_id: '-100777' } },
      ctx({ personalityId: 'support' }),
    );

    expect(result.ok).toBe(true);
    expect(await manager.listWatchers()).toHaveLength(1);
  });

  it('leaves every personality unchanged when no outbox is wired', async () => {
    const tool = createWatcherTools(manager).find((t) => t.name === 'watcher_create');
    if (!tool) throw new Error('watcher_create not registered');

    const result = await tool.execute(
      { ...baseArgs, deliver: { platform: 'telegram', chat_id: '-100777' } },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(await manager.listWatchers()).toHaveLength(1);
  });
});
