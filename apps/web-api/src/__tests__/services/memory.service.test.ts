import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { FsStorage } from '@ethosagent/storage-fs';
import { createMemoryProvider, HistoryStore } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from '../../services/memory.service';

const PERSONALITY_ID = 'test-agent';

describe('MemoryService', () => {
  let dir: string;
  let personalityDir: string;
  let service: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-memory-'));
    personalityDir = join(dir, 'personalities', PERSONALITY_ID);
    await mkdir(personalityDir, { recursive: true });
    service = new MemoryService({
      memory: new MarkdownFileMemoryProvider({ dir, storage: new FsStorage() }),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get returns empty content + null modifiedAt when the file does not exist', async () => {
    const { file } = await service.get('memory', PERSONALITY_ID);
    expect(file.store).toBe('memory');
    expect(file.content).toBe('');
    expect(file.modifiedAt).toBeNull();
    expect(file.path).toBeNull();
  });

  it('write creates the file and returns the freshly-read state', async () => {
    const result = await service.write('memory', '# project context\n\nfirst note', PERSONALITY_ID);
    // The markdown provider trims + appends a trailing newline on replace
    expect(result.file.content).toBe('# project context\n\nfirst note\n');
    expect(result.file.modifiedAt).not.toBeNull();
    expect(await readFile(join(personalityDir, 'MEMORY.md'), 'utf-8')).toBe(
      '# project context\n\nfirst note\n',
    );
  });

  it('write to user store uses USER.md in personality dir', async () => {
    await service.write('user', 'I am Mitesh.', PERSONALITY_ID);
    // The markdown provider trims + appends a trailing newline on replace.
    expect(await readFile(join(personalityDir, 'USER.md'), 'utf-8')).toBe('I am Mitesh.\n');
    const { file } = await service.get('user', PERSONALITY_ID);
    expect(file.path).toBeNull();
  });

  it('read picks up out-of-band edits', async () => {
    await writeFile(join(personalityDir, 'MEMORY.md'), 'edited externally');
    const { file } = await service.get('memory', PERSONALITY_ID);
    expect(file.content).toBe('edited externally');
  });

  it('list returns both files in [memory, user] order', async () => {
    await service.write('memory', 'm', PERSONALITY_ID);
    await service.write('user', 'u', PERSONALITY_ID);
    const { items } = await service.list(PERSONALITY_ID);
    expect(items.map((f) => f.store)).toEqual(['memory', 'user']);
  });

  it('listUsers returns empty when no identityMap is wired', async () => {
    const { users } = await service.listUsers();
    expect(users).toEqual([]);
  });
});

describe('MemoryService.history / restore (Timeline)', () => {
  let dir: string;
  let history: HistoryStore;
  let service: MemoryService;
  const storage = new FsStorage();
  const scopeId = `personality:${PERSONALITY_ID}`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-memory-hist-'));
    await mkdir(join(dir, 'personalities', PERSONALITY_ID), { recursive: true });
    history = new HistoryStore({ dataDir: dir, storage });
    service = new MemoryService({
      memory: new MarkdownFileMemoryProvider({ dir, storage }),
      history,
      restoreMemory: createMemoryProvider({ dataDir: dir, storage, source: 'restore' }),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns entries from all six write sources, newest-first', async () => {
    const sources = [
      'tool',
      'consolidation',
      'dream',
      'capture',
      'web-editor',
      'global-entry',
    ] as const;
    for (const source of sources) {
      await history.record({
        scopeId,
        key: 'MEMORY.md',
        actions: ['add'],
        source,
        sessionId: 's',
        sessionKey: 'cli',
        before: `before ${source}`,
        after: `after ${source}`,
        ...(source === 'capture' ? { hint: 0.7 } : {}),
      });
    }

    const { entries } = await service.history(PERSONALITY_ID, {});
    expect(entries.map((e) => e.source).sort()).toEqual([...sources].sort());
    // Newest-first: the last-recorded source leads.
    expect(entries[0]?.source).toBe('global-entry');
    // Capture entry carries its importance hint.
    expect(entries.find((e) => e.source === 'capture')?.hint).toBe(0.7);
  });

  it('paginates a large history with an opaque cursor', async () => {
    for (let i = 0; i < 120; i++) {
      await history.record({
        scopeId,
        key: 'MEMORY.md',
        actions: ['add'],
        source: 'tool',
        sessionId: 's',
        sessionKey: 'cli',
        before: `b${i}`,
        after: `a${i}`,
      });
    }
    const page1 = await service.history(PERSONALITY_ID, { limit: 50 });
    expect(page1.entries).toHaveLength(50);
    expect(page1.nextCursor).toBe('50');

    const page2 = await service.history(PERSONALITY_ID, { limit: 50, cursor: page1.nextCursor });
    expect(page2.entries).toHaveLength(50);
    const page3 = await service.history(PERSONALITY_ID, { limit: 50, cursor: page2.nextCursor });
    expect(page3.entries).toHaveLength(20);
    expect(page3.nextCursor).toBeNull();
  });

  it('recovers an oversized diff before-state from its blob', async () => {
    const big = 'x'.repeat(6000);
    const entry = await history.record({
      scopeId,
      key: 'MEMORY.md',
      actions: ['replace'],
      source: 'consolidation',
      sessionId: 's',
      sessionKey: 'cli',
      before: big,
      after: 'small',
    });
    expect(entry?.blob).toBeDefined();
    const blob = entry?.blob ?? '';
    const { content } = await service.historyBlob(PERSONALITY_ID, blob);
    expect(content).toBe(big);
  });

  it('restore round-trips a slug and records itself in the history', async () => {
    const personalityDir = join(dir, 'personalities', PERSONALITY_ID);
    const iso = new Date().toISOString();
    const archive = `<!-- archived ${iso} slug=old-project from=MEMORY.md -->\n### old-project\n\nShipped in 2024.`;
    await writeFile(join(personalityDir, 'memory-archive.md'), archive);

    const { ok, restoredTo } = await service.restore(PERSONALITY_ID, 'old-project');
    expect(ok).toBe(true);
    expect(restoredTo).toBe('MEMORY.md');

    // Section moved back into MEMORY.md.
    const memory = await readFile(join(personalityDir, 'MEMORY.md'), 'utf-8');
    expect(memory).toContain('### old-project');
    // Archive no longer holds it.
    const newArchive = await readFile(join(personalityDir, 'memory-archive.md'), 'utf-8');
    expect(newArchive).not.toContain('slug=old-project');

    // The move recorded itself under source 'restore'.
    const { entries } = await service.history(PERSONALITY_ID, { source: 'restore' });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.source === 'restore')).toBe(true);
  });

  it('restore throws NOT_FOUND for an unknown slug', async () => {
    const personalityDir = join(dir, 'personalities', PERSONALITY_ID);
    await writeFile(join(personalityDir, 'memory-archive.md'), '');
    await expect(service.restore(PERSONALITY_ID, 'nope')).rejects.toThrow();
  });
});
