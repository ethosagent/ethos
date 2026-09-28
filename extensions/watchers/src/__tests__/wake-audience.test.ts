// plan personality-memory-boundary step 5 — the room audience a watcher wake
// carries (`WatcherManager.wakeAudience`, G1-6): shared when the watcher has no
// owner, when its creating turn was shared, when a pre-stamp owner's origin
// chat is not provably private, or when its delivery target is not.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { TurnAudience } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type WatcherCreateInput,
  WatcherManager,
  type WatcherOwner,
  type WatcherWakeEvent,
} from '../index';

/** Telegram-style classifier: a positive id is a DM; `-100…` is a group. */
const classify = (_platform: string, chatId: string): TurnAudience =>
  /^\d+$/.test(chatId) ? 'private' : 'shared';

async function wakeOnce(
  input: Partial<WatcherCreateInput> & { owner?: WatcherOwner },
  opts: { targetAudience?: (platform: string, chatId: string) => TurnAudience } = {
    targetAudience: classify,
  },
): Promise<WatcherWakeEvent | undefined> {
  const storage = new InMemoryStorage();
  const woken: WatcherWakeEvent[] = [];
  const manager = new WatcherManager({
    storage,
    watchersDir: '/ethos/watchers',
    deliver: async () => {},
    wake: async (event) => {
      woken.push(event);
    },
    ...(opts.targetAudience ? { targetAudience: opts.targetAudience } : {}),
  });
  await storage.mkdir('/watched');
  await storage.write('/watched/app.log', 'v1');
  await manager.createWatcher({
    id: 'w1',
    kind: 'file',
    target: '/watched/app.log',
    intervalSeconds: 60,
    onChange: { wake: { personalityId: 'ops' } },
    ...input,
  });
  await manager.tick('w1');
  await storage.write('/watched/app.log', 'v2');
  await manager.tick('w1');
  return woken[0];
}

describe('WatcherManager wake audience', () => {
  it('an ownerless watcher wakes shared', async () => {
    expect((await wakeOnce({}))?.roomAudience).toBe('shared');
  });

  it('a watcher a group-chat turn created wakes shared', async () => {
    const event = await wakeOnce({
      owner: { personalityId: 'ops', origin: 'telegram:-100200', roomAudience: 'shared' },
    });
    expect(event?.roomAudience).toBe('shared');
  });

  it('a watcher a private turn created, with no delivery target, wakes private', async () => {
    const event = await wakeOnce({ owner: { personalityId: 'ops', roomAudience: 'private' } });
    expect(event?.roomAudience).toBe('private');
  });

  it('a private owner delivering to a group wakes shared; to a DM, private', async () => {
    const toGroup = await wakeOnce({
      owner: { personalityId: 'ops', roomAudience: 'private' },
      onChange: {
        wake: { personalityId: 'ops' },
        deliver: { platform: 'telegram', chatId: '-100200' },
      },
    });
    expect(toGroup?.roomAudience).toBe('shared');
    const toDm = await wakeOnce({
      owner: { personalityId: 'ops', roomAudience: 'private' },
      onChange: { wake: { personalityId: 'ops' }, deliver: { platform: 'telegram', chatId: '42' } },
    });
    expect(toDm?.roomAudience).toBe('private');
  });

  it('a pre-stamp owner is judged by its origin chat', async () => {
    expect(
      (await wakeOnce({ owner: { personalityId: 'ops', origin: 'telegram:-100200' } }))
        ?.roomAudience,
    ).toBe('shared');
    expect(
      (await wakeOnce({ owner: { personalityId: 'ops', origin: 'telegram:42' } }))?.roomAudience,
    ).toBe('private');
    // No origin and no target (created from the CLI before stamps): private.
    expect((await wakeOnce({ owner: { personalityId: 'ops' } }))?.roomAudience).toBe('private');
  });

  it('with no classifier wired, any delivery target counts as shared', async () => {
    const event = await wakeOnce(
      {
        owner: { personalityId: 'ops', roomAudience: 'private' },
        onChange: {
          wake: { personalityId: 'ops' },
          deliver: { platform: 'telegram', chatId: '42' },
        },
      },
      {},
    );
    expect(event?.roomAudience).toBe('shared');
  });

  it('watchers.json keeps the owner stamp across a pause and resume', async () => {
    const storage = new InMemoryStorage();
    const manager = new WatcherManager({ storage, watchersDir: '/ethos/watchers' });
    await manager.createWatcher({
      id: 'w2',
      kind: 'file',
      target: '/x',
      intervalSeconds: 60,
      onChange: { wake: { personalityId: 'ops' } },
      owner: { personalityId: 'ops', roomAudience: 'shared' },
    });
    await manager.pauseWatcher('w2');
    await manager.resumeWatcher('w2');
    const [record] = await manager.listWatchers();
    expect(record?.owner?.roomAudience).toBe('shared');
  });
});
