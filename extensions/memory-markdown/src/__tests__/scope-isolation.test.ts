import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

function makeCtx(scopeId: string): MemoryContext {
  return {
    scopeId,
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
  };
}

describe('MarkdownFileMemoryProvider — scope isolation', () => {
  it('two providers with different scopeIds sharing the same storage have fully isolated stores', async () => {
    const storage = new InMemoryStorage();

    const providerA = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });
    const providerB = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });

    const ctxA = makeCtx('personality:alpha');
    const ctxB = makeCtx('personality:beta');

    await providerA.sync([{ action: 'add', key: 'MEMORY.md', content: 'Alpha fact.' }], ctxA);
    await providerB.sync([{ action: 'add', key: 'MEMORY.md', content: 'Beta fact.' }], ctxB);

    const snapshotA = await providerA.prefetch(ctxA);
    const snapshotB = await providerB.prefetch(ctxB);

    const allA = snapshotA?.entries.map((e) => e.content).join('\n') ?? '';
    const allB = snapshotB?.entries.map((e) => e.content).join('\n') ?? '';

    expect(allA).toContain('Alpha fact.');
    expect(allA).not.toContain('Beta fact.');
    expect(allB).toContain('Beta fact.');
    expect(allB).not.toContain('Alpha fact.');
  });

  it('a write to one scope is invisible to a read in the other scope', async () => {
    const storage = new InMemoryStorage();

    const provider = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });

    const ctxA = makeCtx('personality:alpha');
    const ctxB = makeCtx('personality:beta');

    await provider.sync([{ action: 'replace', key: 'MEMORY.md', content: 'Alpha only.' }], ctxA);

    const entry = await provider.read('MEMORY.md', ctxB);
    expect(entry).toBeNull();
  });
});
