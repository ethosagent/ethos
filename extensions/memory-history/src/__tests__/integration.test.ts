import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { GlobalMemoryStore, MemoryContext, MemoryProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { withHistory } from '../decorator';
import { HistoryStore } from '../history-store';
import type { HistorySource } from '../types';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';

function ctx(over: Partial<MemoryContext> = {}): MemoryContext {
  return {
    scopeId: SCOPE,
    sessionId: 'sess-1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    ...over,
  };
}

describe('integration — every source produces exactly one correctly-labelled entry', () => {
  it('drives tool, consolidation, web-editor, capture, dream, and global-entry', async () => {
    const storage = new InMemoryStorage();
    const base = new MarkdownFileMemoryProvider({ dir: DATA, storage });
    const history = new HistoryStore({ dataDir: DATA, storage });

    const handle = (source: HistorySource): MemoryProvider & GlobalMemoryStore =>
      withHistory(base, history, { source });

    // tool
    await handle('tool').sync([{ action: 'add', key: 'MEMORY.md', content: 'tool fact' }], ctx());
    // consolidation
    await handle('consolidation').sync(
      [{ action: 'replace', key: 'MEMORY.md', content: 'consolidated' }],
      ctx(),
    );
    // web-editor (whole-file replace of USER.md)
    await handle('web-editor').sync(
      [{ action: 'replace', key: 'USER.md', content: 'web edited profile' }],
      ctx(),
    );
    // capture (add-only)
    await handle('capture').sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'captured fact' }],
      ctx(),
    );
    // dream (same tool handle, dream: sessionKey → derived source)
    await handle('tool').sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'dreamt fact' }],
      ctx({ sessionKey: 'dream:muse:9' }),
    );
    // global-entry
    await handle('tool').writeGlobalEntry('memory', 'global root memory');

    const personality = await history.read(SCOPE);
    const personalitySources = personality.entries.map((e) => e.source).sort();
    expect(personalitySources).toEqual(
      ['capture', 'consolidation', 'dream', 'tool', 'web-editor'].sort(),
    );

    const globalHist = await history.read('global');
    expect(globalHist.entries).toHaveLength(1);
    expect(globalHist.entries[0]?.source).toBe('global-entry');

    // Each personality entry carries a real diff and session attribution.
    for (const e of personality.entries) {
      expect(e.diff.length).toBeGreaterThan(0);
      expect(e.sessionId).toBe('sess-1');
    }
  });
});
