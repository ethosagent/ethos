// CC-1: Atomic registry read-modify-write
//
// Without a lock, concurrent register() calls from multiple async contexts
// race: all read the same state, each writes back only their own entry, and
// the last writer wins — silently dropping everyone else's registration.
//
// With the O_EXCL-based registry lock, every RMW cycle is serialised; all
// concurrent registrations land in the final registry.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { AgentMesh } from '../../index';

function makeMesh(): AgentMesh {
  const path = join(tmpdir(), `mesh-cc1-${Date.now()}-${Math.random()}.json`);
  return new AgentMesh(path, { storage: new FsStorage() });
}

function entry(id: string, port: number) {
  return {
    agentId: id,
    capabilities: ['test'],
    model: 'claude-sonnet-4-6',
    pid: process.pid,
    host: 'localhost',
    port,
    activeSessions: 0,
  };
}

describe('CC-1: atomic registry RMW (concurrent register)', () => {
  it('8 concurrent register() calls all land in the registry', async () => {
    const mesh = makeMesh();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => mesh.register(entry(`agent-${i}`, 3100 + i))),
    );

    const list = await mesh.list();
    expect(list).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(list.some((e) => e.agentId === `agent-${i}`)).toBe(true);
    }
  });

  it('16 concurrent register() calls all land in the registry', async () => {
    const mesh = makeMesh();

    await Promise.all(
      Array.from({ length: 16 }, (_, i) => mesh.register(entry(`agent-${i}`, 3200 + i))),
    );

    const list = await mesh.list();
    expect(list).toHaveLength(16);
  });

  it('concurrent register + heartbeat + unregister do not corrupt registry', async () => {
    const mesh = makeMesh();
    // Pre-register 4 agents
    await Promise.all(
      Array.from({ length: 4 }, (_, i) => mesh.register(entry(`stable-${i}`, 3300 + i))),
    );

    // Concurrently: register 4 new, heartbeat 4 existing, unregister 1
    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => mesh.register(entry(`new-${i}`, 3400 + i))),
      ...Array.from({ length: 4 }, (_, i) => mesh.heartbeat(`stable-${i}`, i)),
      mesh.unregister('stable-0'),
    ]);

    const list = await mesh.list();
    // 4 stable - 1 unregistered + 4 new = 7
    expect(list).toHaveLength(7);
    expect(list.some((e) => e.agentId === 'stable-0')).toBe(false);
    for (let i = 0; i < 4; i++) {
      expect(list.some((e) => e.agentId === `new-${i}`)).toBe(true);
    }
  });

  it('second lock attempt is serialised — no deadlock', async () => {
    const mesh = makeMesh();

    // Two sequential lock cycles should not deadlock or fail.
    await mesh.register(entry('a', 3500));
    await mesh.register(entry('b', 3501));

    const list = await mesh.list();
    expect(list).toHaveLength(2);
  });
});

describe('mesh isolation — separate meshes do not share registries', () => {
  it('two AgentMesh instances at different paths are fully isolated', async () => {
    const meshA = new AgentMesh(join(tmpdir(), `mesh-isolation-a-${Date.now()}.json`), {
      storage: new FsStorage(),
    });
    const meshB = new AgentMesh(join(tmpdir(), `mesh-isolation-b-${Date.now()}.json`), {
      storage: new FsStorage(),
    });

    await meshA.register(entry('agent-a', 4001));
    await meshB.register(entry('agent-b', 4002));

    const listA = await meshA.list();
    const listB = await meshB.list();

    expect(listA).toHaveLength(1);
    expect(listA[0]?.agentId).toBe('agent-a');

    expect(listB).toHaveLength(1);
    expect(listB[0]?.agentId).toBe('agent-b');

    // route_to_agent in meshA cannot find agent-b
    expect(await meshA.route('test')).toEqual(expect.objectContaining({ agentId: 'agent-a' }));
    expect(await meshB.route('test')).toEqual(expect.objectContaining({ agentId: 'agent-b' }));
  });

  it('meshRegistryPath produces distinct paths for different mesh names', async () => {
    const { meshRegistryPath } = await import('../../index');
    const pathA = meshRegistryPath('analytics');
    const pathB = meshRegistryPath('engineering');
    const pathDefault = meshRegistryPath('default');

    expect(pathA).not.toBe(pathB);
    expect(pathA).not.toBe(pathDefault);
    expect(pathB).not.toBe(pathDefault);
    expect(pathA).toContain('analytics');
    expect(pathB).toContain('engineering');
    expect(pathDefault).toContain('default');
  });
});
