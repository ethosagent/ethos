import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import {
  createMemoryProvider,
  createPendingMemoryStore,
  HistoryStore,
  type PendingMemoryStore,
  type TombstoneStore,
} from '@ethosagent/wiring';
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

describe('MemoryService.pending (approve-before-store, L3)', () => {
  const scopeId = `personality:${PERSONALITY_ID}`;
  const dataDir = '/data';
  let storage: InMemoryStorage;
  let store: PendingMemoryStore;
  let tombstones: TombstoneStore;
  let history: HistoryStore;
  let service: MemoryService;

  beforeEach(() => {
    storage = new InMemoryStorage();
    const pending = createPendingMemoryStore({ dataDir, storage });
    store = pending.store;
    tombstones = pending.tombstones;
    history = new HistoryStore({ dataDir, storage });
    service = new MemoryService({
      memory: new MarkdownFileMemoryProvider({ dir: dataDir, storage }),
      history,
      pending: store,
    });
  });

  it('pendingList surfaces a parked candidate with its source + update', async () => {
    await store.propose({
      scopeId,
      source: 'capture',
      factHash: 'h1',
      update: { action: 'add', key: 'MEMORY.md', content: 'user prefers dark mode' },
    });
    const { pending } = await service.pendingList(PERSONALITY_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.source).toBe('capture');
    expect(pending[0]?.factHash).toBe('h1');
    expect(pending[0]?.update).toEqual({
      action: 'add',
      key: 'MEMORY.md',
      content: 'user prefers dark mode',
    });
  });

  it('approve writes through under the original source + approvedBy, then clears the queue', async () => {
    const entry = await store.propose({
      scopeId,
      source: 'capture',
      factHash: 'h1',
      update: { action: 'add', key: 'MEMORY.md', content: 'ships on fridays' },
    });

    const res = await service.pendingApprove(PERSONALITY_ID, entry.id);
    expect(res.ok).toBe(true);

    // Durable memory now holds the approved fact.
    const { file } = await service.get('memory', PERSONALITY_ID);
    expect(file.content).toContain('ships on fridays');

    // Queue is emptied.
    const { pending } = await service.pendingList(PERSONALITY_ID);
    expect(pending).toHaveLength(0);

    // History records it under the ORIGINAL source plus approvedBy: 'web'.
    const { entries } = await history.read(scopeId, {});
    const rec = entries.find((e) => e.source === 'capture');
    expect(rec).toBeDefined();
    expect(rec?.approvedBy).toBe('web');
  });

  it('reject tombstones the fact-hash, writes nothing, and clears the queue', async () => {
    const entry = await store.propose({
      scopeId,
      source: 'capture',
      factHash: 'h-reject',
      update: { action: 'add', key: 'MEMORY.md', content: 'a bad inference' },
    });

    const res = await service.pendingReject(PERSONALITY_ID, entry.id);
    expect(res.ok).toBe(true);

    expect(await tombstones.has(scopeId, 'h-reject')).toBe(true);

    const { pending } = await service.pendingList(PERSONALITY_ID);
    expect(pending).toHaveLength(0);

    // Nothing reached durable memory.
    const { file } = await service.get('memory', PERSONALITY_ID);
    expect(file.content).toBe('');
  });

  it('under memory: vault, approve replays into the vault (history in .ethos-meta), not dataDir', async () => {
    const vaultStorage = new InMemoryStorage();
    const vaultPending = createPendingMemoryStore({
      dataDir,
      storage: vaultStorage,
      config: { memory: 'vault', memoryVault: { path: '/vault' } },
    });
    const vaultService = new MemoryService({
      memory: new MarkdownFileMemoryProvider({ dir: dataDir, storage: vaultStorage }),
      pending: vaultPending.store,
    });
    const entry = await vaultPending.store.propose({
      scopeId,
      source: 'capture',
      factHash: 'h-vault',
      update: { action: 'add', key: 'MEMORY.md', content: 'lives in Bengaluru' },
    });

    const res = await vaultService.pendingApprove(PERSONALITY_ID, entry.id);
    expect(res.ok).toBe(true);

    // Approved fact landed in the vault agent dir, not under dataDir.
    const agentRoot = join('/vault', 'Ethos');
    const scopeDir = join(agentRoot, 'personalities', PERSONALITY_ID);
    expect(await vaultStorage.read(join(scopeDir, 'MEMORY.md'))).toContain('lives in Bengaluru');
    expect(
      await vaultStorage.read(join(dataDir, 'personalities', PERSONALITY_ID, 'MEMORY.md')),
    ).toBeNull();
    const { file } = await vaultService.get('memory', PERSONALITY_ID);
    expect(file.content).toBe('');

    // Provenance history recorded under the vault's .ethos-meta, with the
    // ORIGINAL source plus approvedBy: 'web' — and none at dataDir.
    const metaHistory = new HistoryStore({
      dataDir: join(agentRoot, '.ethos-meta'),
      storage: vaultStorage,
    });
    const { entries } = await metaHistory.read(scopeId, {});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('capture');
    expect(entries[0]?.approvedBy).toBe('web');
    expect(
      await vaultStorage.read(
        join(dataDir, 'personalities', PERSONALITY_ID, 'memory-history.jsonl'),
      ),
    ).toBeNull();
  });

  it('approve / reject of an unknown id throws NOT_FOUND', async () => {
    await expect(service.pendingApprove(PERSONALITY_ID, 'nope')).rejects.toThrow();
    await expect(service.pendingReject(PERSONALITY_ID, 'nope')).rejects.toThrow();
  });

  it('degrades to empty / NOT_CONFIGURED when no queue is wired', async () => {
    const bare = new MemoryService({
      memory: new MarkdownFileMemoryProvider({ dir: dataDir, storage }),
    });
    expect(await bare.pendingList(PERSONALITY_ID)).toEqual({ pending: [] });
    await expect(bare.pendingApprove(PERSONALITY_ID, 'x')).rejects.toThrow();
    await expect(bare.pendingReject(PERSONALITY_ID, 'x')).rejects.toThrow();
  });
});
