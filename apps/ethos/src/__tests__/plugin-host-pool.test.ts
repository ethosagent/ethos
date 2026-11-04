import { FsStorage } from '@ethosagent/storage-fs';
import { PluginHostPool } from '@ethosagent/wiring';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeProcessPluginHostPool,
  getProcessPluginHostPool,
  openProcessPluginHostPool,
  resolvePluginHostChildEntry,
} from '../plugin-host-pool';

// plugin-process-isolation D4/D14: one pool per process, opened by the host
// command and lent by `createAgentLoop` in ../wiring.ts.
afterEach(async () => {
  vi.restoreAllMocks();
  await closeProcessPluginHostPool();
});

describe('process plugin host pool', () => {
  it('resolves the child entry beside the app source', async () => {
    const entry = await resolvePluginHostChildEntry(new FsStorage());
    expect(entry?.endsWith('plugin-host-child.ts')).toBe(true);
  });

  it('opens one pool, idempotently, and closes it once', async () => {
    const dispose = vi.spyOn(PluginHostPool.prototype, 'dispose');
    const a = await openProcessPluginHostPool({}, new FsStorage());
    const b = await openProcessPluginHostPool({}, new FsStorage());
    expect(a).toBeInstanceOf(PluginHostPool);
    expect(b).toBe(a);
    expect(getProcessPluginHostPool()).toBe(a);

    await closeProcessPluginHostPool();
    expect(getProcessPluginHostPool()).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
