// WorldConfigService: the only writer of world.yaml and worlds.yaml (plan
// world-model Task 2.5; single-owner rule in docs/decisions/0012-world-graph-contract.md).

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { WorldConfigError } from '../config';
import { WorldConfigService } from '../config-service';

const DATA = '/data';
const NOW = new Date('2026-11-28T00:00:00.000Z');

function make(storage: Storage = new InMemoryStorage()) {
  return {
    storage,
    svc: new WorldConfigService({ storage, dataDir: DATA, now: () => NOW }),
  };
}

describe('WorldConfigService', () => {
  it('config service writes atomically and refuses unknown keys', async () => {
    const calls: string[] = [];
    const inner = new InMemoryStorage();
    const storage = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (prop === 'write' || prop === 'writeAtomic') calls.push(String(prop));
          return v.apply(target, args);
        };
      },
    }) as Storage;
    const { svc } = make(storage);

    await svc.writeWorld(
      { id: 'acme', title: 'Acme', audience: 'shareable', readers: ['engineer'] },
      { by: 'cli:owner' },
    );
    expect(calls).toEqual(['writeAtomic']);

    const text = await inner.read(`${DATA}/worlds/acme/world.yaml`);
    expect(text).toContain('# written by cli:owner at 2026-11-28T00:00:00.000Z');
    const worlds = await svc.listWorlds();
    expect(worlds.get('acme')).toMatchObject({ id: 'acme', audience: 'shareable' });

    // Unknown keys are refused and nothing is written.
    await expect(
      svc.writeWorld({ id: 'bad', title: 'Bad', extra: 1 } as never, { by: 'cli:owner' }),
    ).rejects.toBeInstanceOf(WorldConfigError);
    expect(await inner.exists(`${DATA}/worlds/bad/world.yaml`)).toBe(false);
    await expect(
      svc.writeMounts('engineer', { mounts: [], bogus: true } as never, { by: 'cli:owner' }),
    ).rejects.toBeInstanceOf(WorldConfigError);
    expect(await inner.exists(`${DATA}/personalities/engineer/worlds.yaml`)).toBe(false);

    // A hand edit with an unknown key is refused on load, with its line.
    await inner.write(`${DATA}/worlds/acme/world.yaml`, 'id: acme\ntitle: Acme\nnope: 1\n');
    await expect(svc.readWorld('acme')).rejects.toThrow(/line 3: unknown key "nope"/);
    await expect(svc.listWorlds()).rejects.toBeInstanceOf(WorldConfigError);
  });

  it('config service refuses a mount alias collision', async () => {
    const { svc, storage } = make();
    await expect(
      svc.writeMounts(
        'engineer',
        {
          mounts: [
            { world: 'acme', mode: 'read', as: 'crm' },
            { world: 'globex', mode: 'propose', as: 'crm' },
          ],
        },
        { by: 'cli:owner' },
      ),
    ).rejects.toThrow(/duplicate alias "crm"/);
    await expect(
      svc.writeMounts(
        'engineer',
        {
          mounts: [
            { world: 'acme', mode: 'read', as: 'globex' },
            { world: 'globex', mode: 'read' },
          ],
        },
        { by: 'cli:owner' },
      ),
    ).rejects.toThrow(/equals the slug of another mounted world/);
    expect(await storage.exists(`${DATA}/personalities/engineer/worlds.yaml`)).toBe(false);

    await svc.writeMounts(
      'engineer',
      { mounts: [{ world: 'acme', mode: 'read', as: 'crm' }] },
      { by: 'cli:owner' },
    );
    expect(await svc.readMounts('engineer')).toEqual({
      mounts: [{ world: 'acme', mode: 'read', as: 'crm' }],
    });
    expect(await svc.readMounts('nobody')).toEqual({ mounts: [] });
  });

  it('refuses an unsafe world slug or personality id before touching disk', async () => {
    const { svc, storage } = make();
    await expect(
      svc.writeWorld({ id: '../evil', title: 'x' } as never, { by: 'cli:owner' }),
    ).rejects.toBeInstanceOf(WorldConfigError);
    await expect(svc.writeMounts('../evil', { mounts: [] }, { by: 'cli:owner' })).rejects.toThrow(
      /personality id/,
    );
    expect(await storage.exists(`${DATA}/worlds`)).toBe(false);
  });
});
