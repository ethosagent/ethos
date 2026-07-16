import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

const ctx: MemoryContext = {
  scopeId: 'personality:test',
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};

describe('MarkdownFileMemoryProvider — 512KB overflow routes to archive (§2.3)', () => {
  it('trimmed content is preserved in memory-archive.md, not dropped', async () => {
    const storage = new InMemoryStorage();
    const provider = new MarkdownFileMemoryProvider({ dir: '/root/.ethos', storage });
    const padding = 'y'.repeat(100 * 1024);
    for (let i = 0; i < 6; i++) {
      await provider.sync(
        [{ key: 'MEMORY.md', action: 'add', content: `UNIQUE_MARKER_${i}\n${padding}` }],
        ctx,
      );
    }

    const entry = await provider.read('MEMORY.md', ctx);
    const content = entry?.content ?? '';
    expect(content.length).toBeLessThanOrEqual(512 * 1024);
    // Oldest entry was trimmed out of the live file...
    expect(content).not.toContain('UNIQUE_MARKER_0');

    // ...but survives in the scope archive.
    const archive = await storage.read('/root/.ethos/personalities/test/memory-archive.md');
    expect(archive).not.toBeNull();
    expect(archive).toContain('UNIQUE_MARKER_0');
    expect(archive).toContain('overflow-archived');
  });
});
