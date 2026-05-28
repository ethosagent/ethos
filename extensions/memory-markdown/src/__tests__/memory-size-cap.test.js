import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

const globalCtx = {
  scopeId: 'personality:test',
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};
let testDir;
let provider;
beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-memory-cap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(testDir, 'personalities', 'test'), { recursive: true });
  provider = new MarkdownFileMemoryProvider({ dir: testDir });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});
describe('MarkdownFileMemoryProvider — size cap', () => {
  it('trims content exceeding 512KB via repeated add operations', async () => {
    const key = 'MEMORY.md';
    // Use fewer, larger chunks to stay within timeout. 6 chunks of ~100KB = ~600KB total.
    const chunk = 'x'.repeat(100 * 1024);
    for (let i = 0; i < 6; i++) {
      await provider.sync([{ key, action: 'add', content: `entry-${i}\n${chunk}` }], globalCtx);
    }
    const entry = await provider.read(key, globalCtx);
    expect(entry).not.toBeNull();
    const content = entry?.content ?? '';
    // Content should be at most 512KB (minus any trimmed partial first line)
    expect(content.length).toBeLessThanOrEqual(512 * 1024);
  }, 15_000);
  it('preserves the most recent entries after trimming', async () => {
    const key = 'MEMORY.md';
    // Use fewer, larger chunks with identifiable markers. 6 x 100KB = 600KB > 512KB cap.
    const padding = 'y'.repeat(100 * 1024);
    for (let i = 0; i < 6; i++) {
      await provider.sync(
        [{ key, action: 'add', content: `UNIQUE_MARKER_${i}\n${padding}` }],
        globalCtx,
      );
    }
    const entry = await provider.read(key, globalCtx);
    expect(entry).not.toBeNull();
    const content = entry?.content ?? '';
    // The most recent entries should be present
    expect(content).toContain('UNIQUE_MARKER_5');
    expect(content).toContain('UNIQUE_MARKER_4');
    // The oldest entry should have been trimmed away
    expect(content).not.toContain('UNIQUE_MARKER_0');
  }, 15_000);
  it('does not trim content under 512KB', async () => {
    const key = 'MEMORY.md';
    // Write content well under the limit
    for (let i = 0; i < 5; i++) {
      await provider.sync([{ key, action: 'add', content: `small-entry-${i}` }], globalCtx);
    }
    const entry = await provider.read(key, globalCtx);
    expect(entry).not.toBeNull();
    const content = entry?.content ?? '';
    // All entries should be present
    for (let i = 0; i < 5; i++) {
      expect(content).toContain(`small-entry-${i}`);
    }
  });
});
