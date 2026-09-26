// The nightly pass's memory step (`nightlyMemory`, the handle `runNightlyOnce`
// hands `buildDeps`) must write where and how the runtime writes:
//   - `memoryApproval.mode: all` gates `consolidation` (`MemoryApprovalMode`),
//     so the pass's MEMORY.md / USER.md writes park in the SAME pending queue
//     `ethos memory pending` and the web Pending tab read (`createMemoryBundle`),
//     and approve replays them under their original source;
//   - `memory: vector` has no MEMORY.md / USER.md files and no sidecar, so the
//     step is skipped rather than consolidating a markdown store the agent
//     never reads.

import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { createMemoryBundle } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { nightlyMemory } from '../nightly';

const DATA = '/ethos';
const SCOPE = 'personality:sage';
const MEMORY_FILE = join(DATA, 'personalities', 'sage', 'MEMORY.md');

const ctx: MemoryContext = {
  scopeId: SCOPE,
  sessionId: '',
  sessionKey: 'nightly',
  platform: 'cli',
  workingDir: '',
};

function config(extra: Partial<EthosConfig>): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    apiKey: 'k',
    personality: 'sage',
    ...extra,
  };
}

const update = { action: 'replace' as const, key: 'MEMORY.md', content: 'Consolidated.' };

describe('nightlyMemory — the nightly consolidation write path', () => {
  it('mode all parks the consolidation write in the bundle queue; approve lands it', async () => {
    const storage = new InMemoryStorage();
    const cfg = config({ memoryApproval: { mode: 'all' } });
    const backend = await nightlyMemory(cfg, DATA, storage);
    if ('skipReason' in backend) throw new Error('markdown consolidates');

    await backend.provider.sync([update], ctx);
    expect(await storage.read(MEMORY_FILE)).toBeNull();
    const { pending } = createMemoryBundle({ config: cfg, dataDir: DATA, storage });
    const queued = await pending.list(SCOPE);
    expect(queued.map((p) => [p.source, p.update])).toEqual([['consolidation', update]]);

    const [entry] = queued;
    if (!entry) throw new Error('one pending entry');
    await pending.approve(SCOPE, entry.id, 'cli');
    expect((await storage.read(MEMORY_FILE))?.trim()).toBe('Consolidated.');
    const { entries } = await backend.history.read(SCOPE);
    expect(entries.map((e) => [e.source, e.approvedBy])).toEqual([['consolidation', 'cli']]);
  });

  it.each(['off', 'automated'] as const)('mode %s writes straight through', async (mode) => {
    const storage = new InMemoryStorage();
    const backend = await nightlyMemory(config({ memoryApproval: { mode } }), DATA, storage);
    if ('skipReason' in backend) throw new Error('markdown consolidates');

    await backend.provider.sync([update], ctx);
    expect((await storage.read(MEMORY_FILE))?.trim()).toBe('Consolidated.');
    const { entries } = await backend.history.read(SCOPE);
    expect(entries.map((e) => e.source)).toEqual(['consolidation']);
  });

  it('memory: vector skips consolidation instead of writing dataDir markdown', async () => {
    const storage = new InMemoryStorage();
    const backend = await nightlyMemory(config({ memory: 'vector' }), DATA, storage);
    expect(backend).toMatchObject({ skipReason: expect.stringContaining('"vector"') });
  });
});
