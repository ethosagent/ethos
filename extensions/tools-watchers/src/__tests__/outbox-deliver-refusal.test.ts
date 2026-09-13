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
  gates: (personalityId, platform) => personalityId === 'coordinator' && platform === 'telegram',
  ownerTarget: (platform) => (platform === 'telegram' ? '4242' : undefined),
};

function ctx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'telegram:example-bot:C9',
    platform: 'telegram',
    personalityId: 'coordinator',
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
    const result = await create({ ...baseArgs, wake: { personality_id: 'coordinator' } }, ctx());

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

// Creation is not the only gate: a watcher stored BEFORE the policy was switched
// on must stop delivering at its next change (`WatcherManager.dispatchChange`).
describe('watcher delivery — policy re-read at delivery time', () => {
  const WATCHED = '/watched/app.log';
  let storage: InMemoryStorage;
  let delivered: string[];
  let gated: Set<string>;
  let deliveryManager: WatcherManager;

  // Gates `coordinator` on telegram only while its id is in `gated`, read on
  // every call — the shape of a hot-reloaded `outbound_policy`.
  const liveGate: WatcherOutboxGate = {
    gates: (personalityId, platform) => gated.has(personalityId) && platform === 'telegram',
    ownerTarget: (platform) => (platform === 'telegram' ? '4242' : undefined),
  };

  const turn = (personalityId: string) =>
    ctx({ personalityId, sessionKey: 'telegram:bot:C9', origin: 'telegram:C9' });

  async function createFileWatcher(personalityId: string, chatId: string): Promise<void> {
    const tool = createWatcherTools(deliveryManager, { outbox: liveGate }).find(
      (t) => t.name === 'watcher_create',
    );
    if (!tool) throw new Error('watcher_create not registered');
    const result = await tool.execute(
      {
        id: 'app-log',
        kind: 'file',
        target: WATCHED,
        interval_seconds: 60,
        deliver: { platform: 'telegram', chat_id: chatId },
      },
      turn(personalityId),
    );
    if (!result.ok) throw new Error(result.error);
    await deliveryManager.tick('app-log'); // seed last-seen state
  }

  let version = 0;
  async function change(): Promise<void> {
    version += 1;
    await storage.write(WATCHED, `v${version}`);
    await deliveryManager.tick('app-log');
  }

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir('/watched');
    await storage.write(WATCHED, 'v0');
    delivered = [];
    gated = new Set();
    deliveryManager = new WatcherManager({
      storage,
      watchersDir: '/ethos/watchers',
      deliver: async (target) => {
        delivered.push(`${target.platform}:${target.chatId}`);
      },
      deliveryGate: liveGate,
    });
  });

  it('a watcher stored before gating stops delivering and records why', async () => {
    await createFileWatcher('coordinator', '-100777');
    gated.add('coordinator');

    await change();

    expect(delivered).toEqual([]);
    const record = await deliveryManager.getWatcher('app-log');
    expect(record?.deliveryWithheld?.reason).toContain('telegram:-100777');
    expect(record?.deliveryWithheld?.reason).toContain('wake');
    const list = createWatcherTools(deliveryManager).find((t) => t.name === 'watcher_list');
    const listed = await list?.execute({}, turn('coordinator'));
    expect(listed?.ok && listed.value).toContain('withheld');
  });

  it('a gated personality’s watcher delivering to its origin chat still delivers', async () => {
    await createFileWatcher('coordinator', 'C9');
    gated.add('coordinator');

    await change();

    expect(delivered).toEqual(['telegram:C9']);
    expect((await deliveryManager.getWatcher('app-log'))?.deliveryWithheld).toBeUndefined();
  });

  it('an ungated personality’s watcher still delivers to a foreign chat', async () => {
    await createFileWatcher('member-a', '-100777');
    gated.add('coordinator');

    await change();

    expect(delivered).toEqual(['telegram:-100777']);
  });

  it('a policy changed after creation takes effect on the next delivery', async () => {
    await createFileWatcher('coordinator', '-100777');

    await change();
    expect(delivered).toEqual(['telegram:-100777']);

    gated.add('coordinator');
    await change();
    expect(delivered).toEqual(['telegram:-100777']);
    expect((await deliveryManager.getWatcher('app-log'))?.deliveryWithheld).toBeDefined();

    gated.delete('coordinator');
    await change();
    expect(delivered).toEqual(['telegram:-100777', 'telegram:-100777']);
    expect((await deliveryManager.getWatcher('app-log'))?.deliveryWithheld).toBeUndefined();
  });
});

// The delivery-time gate is the manager's own, given by the app root at
// construction (`WatcherManagerConfig.deliveryGate`) — not whatever gate the
// last loop composed its watcher tools with.
describe('watcher delivery — the gate belongs to the manager', () => {
  const WATCHED = '/watched/app.log';
  const gatesNobody: WatcherOutboxGate = { gates: () => false, ownerTarget: () => undefined };
  let storage: InMemoryStorage;
  let delivered: string[];
  let gatedManager: WatcherManager;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir('/watched');
    await storage.write(WATCHED, 'v0');
    delivered = [];
    gatedManager = new WatcherManager({
      storage,
      watchersDir: '/ethos/watchers',
      deliver: async (target) => {
        delivered.push(`${target.platform}:${target.chatId}`);
      },
      deliveryGate: GATE,
    });
    // Stored by an earlier process: nothing in this one has composed a loop.
    await gatedManager.createWatcher({
      id: 'app-log',
      kind: 'file',
      target: WATCHED,
      intervalSeconds: 60,
      onChange: { deliver: { platform: 'telegram', chatId: '-100777' } },
      owner: { personalityId: 'coordinator', origin: 'telegram:C9' },
    });
    await gatedManager.tick('app-log'); // seed last-seen state
  });

  async function change(): Promise<void> {
    await storage.write(WATCHED, 'v1');
    await gatedManager.tick('app-log');
  }

  it('a tick before any loop is composed still withholds a gated foreign deliver', async () => {
    await change();

    expect(delivered).toEqual([]);
    const record = await gatedManager.getWatcher('app-log');
    expect(record?.deliveryWithheld?.reason).toContain('telegram:-100777');
  });

  it('composing more loops does not replace the manager’s gate', async () => {
    // Two loops, as in a multi-bot gateway; the last one's gate gates nobody.
    createWatcherTools(gatedManager, { outbox: GATE });
    createWatcherTools(gatedManager, { outbox: gatesNobody });

    await change();

    expect(delivered).toEqual([]);
    expect((await gatedManager.getWatcher('app-log'))?.deliveryWithheld).toBeDefined();
  });
});
