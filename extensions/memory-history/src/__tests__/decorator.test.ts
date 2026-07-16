import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { withHistory } from '../decorator';
import { HistoryStore } from '../history-store';

const DATA = '/root/.ethos';

function ctx(over: Partial<MemoryContext> = {}): MemoryContext {
  return {
    scopeId: 'personality:muse',
    sessionId: 's1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    ...over,
  };
}

function make(source: 'tool' | 'consolidation' | 'web-editor' = 'tool') {
  const storage = new InMemoryStorage();
  const base = new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = new HistoryStore({ dataDir: DATA, storage });
  return { storage, base, history, provider: withHistory(base, history, { source }) };
}

describe('HistoryMemoryProvider — write behaviour matches the raw provider', () => {
  it('sync produces the same memory file content as the undecorated provider', async () => {
    const raw = make();
    const dec = make();
    await raw.base.sync([{ action: 'add', key: 'MEMORY.md', content: 'hi' }], ctx());
    await dec.provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'hi' }], ctx());
    const rawEntry = await raw.base.read('MEMORY.md', ctx());
    const decEntry = await dec.provider.read('MEMORY.md', ctx());
    expect(decEntry?.content).toBe(rawEntry?.content);
  });

  it('records exactly one history entry per key in the batch', async () => {
    const { provider, history } = make();
    await provider.sync(
      [
        { action: 'add', key: 'MEMORY.md', content: 'fact one' },
        { action: 'add', key: 'MEMORY.md', content: 'fact two' },
        { action: 'add', key: 'USER.md', content: 'about you' },
      ],
      ctx(),
    );
    const { entries } = await history.read('personality:muse');
    expect(entries).toHaveLength(2);
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(['MEMORY.md', 'USER.md']);
    const mem = entries.find((e) => e.key === 'MEMORY.md');
    expect(mem?.actions).toEqual(['add', 'add']);
    expect(mem?.source).toBe('tool');
    expect(mem?.sessionId).toBe('s1');
  });

  it('derives the dream source from a dream: sessionKey', async () => {
    const { provider, history } = make('tool');
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'nightly note' }],
      ctx({ sessionKey: 'dream:muse:123' }),
    );
    const { entries } = await history.read('personality:muse');
    expect(entries[0]?.source).toBe('dream');
  });

  it('reads/prefetch/list pass through untouched', async () => {
    const { provider } = make();
    await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'hello' }], ctx());
    const snap = await provider.prefetch(ctx());
    expect(snap?.entries.some((e) => e.content.includes('hello'))).toBe(true);
    const list = await provider.list(ctx());
    expect(list.some((r) => r.key === 'MEMORY.md')).toBe(true);
  });

  it('writeGlobalEntry records under global-entry and uses an atomic write', async () => {
    const storage = new InMemoryStorage();
    let atomicCalls = 0;
    const origAtomic = storage.writeAtomic.bind(storage);
    storage.writeAtomic = async (p, content, opts) => {
      if (p.endsWith('MEMORY.md') || p.endsWith('USER.md')) atomicCalls++;
      return origAtomic(p, content, opts);
    };
    const base = new MarkdownFileMemoryProvider({ dir: DATA, storage });
    const history = new HistoryStore({ dataDir: DATA, storage });
    const provider = withHistory(base, history, { source: 'tool' });

    const result = await provider.writeGlobalEntry('memory', 'edited via web');
    expect(result.content).toContain('edited via web');
    expect(atomicCalls).toBeGreaterThan(0);

    const { entries } = await history.read('global');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('global-entry');
    expect(entries[0]?.key).toBe('MEMORY.md');
  });
});
