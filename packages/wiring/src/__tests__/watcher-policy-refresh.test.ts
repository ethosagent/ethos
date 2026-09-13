// O-T12 (plan/phases/trust-before-reach.md) — a watcher delivery reads a FRESH
// `outbound_policy`.
//
// A watcher fires off the cron tick, not a turn, so the per-turn personality
// refresh (gateway, boot) has not run before it — and `ethos serve` reloads its
// registry only through the web API. `createOutboundPolicyGate`'s `reload`
// becomes the gate's `refresh`, which `WatcherManager.dispatchChange` awaits
// before deciding. Driven here through a real `FilePersonalityRegistry` and a
// real `WatcherManager`, with the policy switched on by editing config.yaml.

import { join } from 'node:path';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import { WatcherManager } from '@ethosagent/watchers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createOutboundPolicyGate } from '../compose-tools';

const PERSONALITIES = '/ethos/personalities';
const CONFIG = join(PERSONALITIES, 'coordinator', 'config.yaml');
const WATCHED = '/watched/app.log';

let storage: InMemoryStorage;
let delivered: string[];
let warnings: string[];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg: string) => warnings.push(msg),
  error: () => {},
  child: () => logger,
};

async function managerWith(reload?: (registryReload: () => Promise<void>) => () => Promise<void>) {
  const registry = await createPersonalityRegistry(storage);
  await registry.loadFromDirectory(PERSONALITIES);
  const registryReload = () => registry.loadFromDirectory(PERSONALITIES);
  const manager = new WatcherManager({
    storage,
    watchersDir: '/ethos/watchers',
    logger,
    deliver: async (target) => {
      delivered.push(`${target.platform}:${target.chatId}`);
    },
    deliveryGate: createOutboundPolicyGate({
      lookupPersonality: (id) => registry.get(id),
      ownerTarget: () => undefined,
      ...(reload ? { reload: reload(registryReload) } : {}),
    }),
  });
  await manager.createWatcher({
    id: 'app-log',
    kind: 'file',
    target: WATCHED,
    intervalSeconds: 60,
    onChange: { deliver: { platform: 'telegram', chatId: '-100777' } },
    owner: { personalityId: 'coordinator', origin: 'telegram:C9' },
  });
  await manager.tick('app-log'); // seed last-seen state
  return manager;
}

let version = 0;
async function change(manager: WatcherManager): Promise<void> {
  version += 1;
  await storage.write(WATCHED, `v${version}`);
  await manager.tick('app-log');
}

async function turnApprovalOnOnDisk(): Promise<void> {
  await storage.write(CONFIG, 'name: Coordinator\noutbound_policy.approve_before_send: true\n');
}

beforeEach(async () => {
  storage = new InMemoryStorage();
  delivered = [];
  warnings = [];
  await storage.mkdir(join(PERSONALITIES, 'coordinator'));
  await storage.write(CONFIG, 'name: Coordinator\n');
  await storage.write(join(PERSONALITIES, 'coordinator', 'SOUL.md'), '# Coordinator\n');
  await storage.mkdir('/watched');
  await storage.write(WATCHED, 'v0');
});

describe('watcher delivery — the policy is reloaded before each decision', () => {
  it('a policy turned on on disk, with no turn in between, withholds the next delivery', async () => {
    const manager = await managerWith((registryReload) => registryReload);

    await change(manager);
    expect(delivered).toEqual(['telegram:-100777']);

    await turnApprovalOnOnDisk();
    await change(manager);

    expect(delivered).toEqual(['telegram:-100777']);
    const record = await manager.getWatcher('app-log');
    expect(record?.deliveryWithheld?.reason).toContain('approve_before_send');
  });

  it('without reload, the same edit is invisible until something else reloads the registry', async () => {
    // The failure the reload closes: the registry answers from its last load.
    const manager = await managerWith();

    await turnApprovalOnOnDisk();
    await change(manager);

    expect(delivered).toEqual(['telegram:-100777']);
  });

  it('a failed reload is logged and the last-loaded policy answers', async () => {
    let fail = false;
    const manager = await managerWith((registryReload) => async () => {
      if (fail) throw new Error('disk unavailable');
      await registryReload();
    });
    await turnApprovalOnOnDisk();
    await change(manager); // loads the policy: withheld
    expect(delivered).toEqual([]);

    fail = true;
    await change(manager);

    expect(delivered).toEqual([]);
    expect(warnings.some((w) => w.includes('policy refresh failed'))).toBe(true);
  });
});
