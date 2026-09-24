import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import {
  createMemoryBundle,
  createMemoryProviderFromConfig,
  createPendingMemoryStore,
  type MemoryBackendSelection,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { makeStubAgentLoop, makeStubPersonalityRegistry } from '../test-helpers';

// F04 (plan architecture-suggestions-2026-09-10) — the web memory surfaces
// (editor read/write, Timeline, restore, approve) must target the SAME backend
// the agent reads. Before F04, `ethos serve` / desktop handed the web API a
// markdown-only editor at `dataDir` and web-api built history + restore at
// `dataDir` too, so under `memory: vault` an edit in the web editor never
// reached the vault the agent reads. Driven end-to-end through the RPC.

const PERSONALITY = 'muse';
const SCOPE = `personality:${PERSONALITY}`;

function ctx(): MemoryContext {
  return { scopeId: SCOPE, sessionId: 's', sessionKey: 'cli', platform: 'cli', workingDir: '' };
}

describe('memory RPC follows the configured backend (F04)', () => {
  let root: string;
  let dataDir: string;
  let vaultRoot: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  const storage = new FsStorage();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ethos-memory-backend-rpc-'));
    dataDir = join(root, 'ethos');
    vaultRoot = join(root, 'vault');
    await mkdir(join(dataDir, 'personalities', PERSONALITY), { recursive: true });
    await mkdir(join(vaultRoot, 'Ethos', 'personalities', PERSONALITY), { recursive: true });
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Build the web API the way `ethos serve` / desktop wire it: the bundle
   *  `buildAgentLoop` builds from the loop's config (`memoryBundle`). */
  async function boot(config: MemoryBackendSelection): Promise<void> {
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryBundle: createMemoryBundle({ config, dataDir, storage }),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([{ id: PERSONALITY, name: 'Muse' }]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
    const token = await new WebTokenRepository({ dataDir, storage }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
  }

  // oRPC's JSON serializer wraps both directions in `{ json: ... }`.
  async function call<T>(method: string, input: unknown): Promise<{ status: number; body: T }> {
    const res = await app.request(`/rpc/memory/${method}`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });
    return { status: res.status, body: ((await res.json()) as { json: T }).json };
  }

  describe('memory: vault', () => {
    let config: MemoryBackendSelection;
    let vaultScopeDir: string;

    beforeEach(async () => {
      config = { memory: 'vault', memoryVault: { path: vaultRoot } };
      vaultScopeDir = join(vaultRoot, 'Ethos', 'personalities', PERSONALITY);
      await boot(config);
    });

    /** What the agent reads: the configured backend (`buildVaultBackend`, the
     *  constructor the runtime `vault` registry factory calls). */
    const runtimeRead = async (key: string) =>
      (await createMemoryProviderFromConfig({ config, dataDir, storage }).provider.read(key, ctx()))
        ?.content ?? null;

    it('(a) a web editor write is what the agent reads next', async () => {
      const res = await call<{ file: { content: string } }>('write', {
        store: 'memory',
        content: 'Use the staging account',
        personalityId: PERSONALITY,
      });
      expect(res.status).toBe(200);

      expect(await runtimeRead('MEMORY.md')).toContain('Use the staging account');
      // Nothing written to the markdown tree the agent never reads.
      expect(
        await storage.read(join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md')),
      ).toBeNull();

      // The edit is recorded in the vault's history under `web-editor`.
      const history = await call<{ entries: Array<{ source: string }> }>('history', {
        personalityId: PERSONALITY,
      });
      expect(history.body.entries.map((e) => e.source)).toEqual(['web-editor']);
    });

    it('(a) the editor reads what the agent wrote', async () => {
      await createMemoryProviderFromConfig({ config, dataDir, storage }).provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: 'deploys on tuesdays' }],
        ctx(),
      );
      const res = await call<{ file: { content: string } }>('get', {
        store: 'memory',
        personalityId: PERSONALITY,
      });
      expect(res.body.file.content).toContain('deploys on tuesdays');
    });

    it('(b) an approved candidate is visible to the editor and the Timeline', async () => {
      // The runtime gate parks candidates in the dataDir queue.
      const { store: queue } = createPendingMemoryStore({ dataDir, storage, config });
      const entry = await queue.propose({
        scopeId: SCOPE,
        source: 'capture',
        factHash: 'h-f04',
        update: { action: 'add', key: 'MEMORY.md', content: 'lives in Bengaluru' },
      });

      const approved = await call<{ ok: boolean }>('pendingApprove', {
        personalityId: PERSONALITY,
        id: entry.id,
      });
      expect(approved.body.ok).toBe(true);

      const file = await call<{ file: { content: string } }>('get', {
        store: 'memory',
        personalityId: PERSONALITY,
      });
      expect(file.body.file.content).toContain('lives in Bengaluru');

      // The replay recorded under its ORIGINAL source, in the history the
      // Timeline reads (the vault's `.ethos-meta`).
      const history = await call<{ entries: Array<{ source: string }> }>('history', {
        personalityId: PERSONALITY,
      });
      expect(history.body.entries.map((e) => e.source)).toEqual(['capture']);
    });

    it('(c) restore moves an archived section back inside the vault', async () => {
      const iso = new Date().toISOString();
      await writeFile(
        join(vaultScopeDir, 'memory-archive.md'),
        `<!-- archived ${iso} slug=old-project from=MEMORY.md -->\n### old-project\n\nShipped in 2024.`,
      );

      const res = await call<{ ok: boolean; restoredTo: string }>('restore', {
        personalityId: PERSONALITY,
        slug: 'old-project',
      });
      expect(res.status).toBe(200);
      expect(res.body.restoredTo).toBe('MEMORY.md');

      expect(await runtimeRead('MEMORY.md')).toContain('### old-project');
      expect(await readFile(join(vaultScopeDir, 'memory-archive.md'), 'utf-8')).not.toContain(
        'slug=old-project',
      );
      const history = await call<{ entries: Array<{ source: string }> }>('history', {
        personalityId: PERSONALITY,
        source: 'restore',
      });
      expect(history.body.entries.length).toBeGreaterThan(0);
    });

    it('(d) the pending queue stays at dataDir, never inside the vault', async () => {
      const { store: queue } = createPendingMemoryStore({ dataDir, storage, config });
      await queue.propose({
        scopeId: SCOPE,
        source: 'capture',
        factHash: 'h-queue',
        update: { action: 'add', key: 'MEMORY.md', content: 'queued fact' },
      });

      const listed = await call<{ pending: Array<{ update: { content?: string } }> }>(
        'pendingList',
        { personalityId: PERSONALITY },
      );
      expect(listed.body.pending.map((p) => p.update.content)).toEqual(['queued fact']);
      expect(
        await storage.read(join(dataDir, 'personalities', PERSONALITY, 'memory-pending.jsonl')),
      ).toContain('queued fact');
      expect(await storage.exists(join(vaultScopeDir, 'memory-pending.jsonl'))).toBe(false);
    });
  });

  describe('memory: vector (no file editor)', () => {
    beforeEach(async () => {
      await boot({ memory: 'vector' });
    });

    it('refuses editor reads, writes and restore with the backend reason, and writes nothing', async () => {
      for (const [method, input] of [
        ['list', { personalityId: PERSONALITY }],
        ['get', { store: 'memory', personalityId: PERSONALITY }],
        [
          'write',
          { store: 'memory', content: 'Use the staging account', personalityId: PERSONALITY },
        ],
        ['restore', { personalityId: PERSONALITY, slug: 'anything' }],
        ['history', { personalityId: PERSONALITY }],
      ] as const) {
        const res = await call<{ code: string; message: string }>(method, input);
        expect(res.status, method).not.toBe(200);
        expect(res.body.code, method).toBe('NOT_CONFIGURED');
        expect(res.body.message, method).toContain('"vector" memory backend has no file editor');
      }
      expect(
        await storage.read(join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md')),
      ).toBeNull();

      // The Timeline refuses with the same reason (an empty list would read as
      // "no history yet"); the approve queue still answers.
      const history = await call<{ code: string; message: string }>('history', {
        personalityId: PERSONALITY,
      });
      expect(history.body.code).toBe('NOT_CONFIGURED');
      expect(history.body.message).toContain('"vector" memory backend has no file editor');
      const pending = await call<{ pending: unknown[] }>('pendingList', {
        personalityId: PERSONALITY,
      });
      expect(pending.body.pending).toEqual([]);
    });

    it('refuses to approve a leftover candidate into vector; reject still clears it', async () => {
      // Parked under an earlier backend — the runtime never gates vector writes.
      const { store: queue } = createPendingMemoryStore({
        dataDir,
        storage,
        config: { memory: 'vector' },
      });
      const entry = await queue.propose({
        scopeId: SCOPE,
        source: 'capture',
        factHash: 'h-leftover',
        update: { action: 'add', key: 'MEMORY.md', content: 'parked under markdown' },
      });

      const approved = await call<{ code: string; message: string }>('pendingApprove', {
        personalityId: PERSONALITY,
        id: entry.id,
      });
      expect(approved.body.code).toBe('NOT_CONFIGURED');
      expect(approved.body.message).toContain('Cannot approve into the "vector" memory backend');
      expect(
        await storage.read(join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md')),
      ).toBeNull();

      const rejected = await call<{ ok: boolean }>('pendingReject', {
        personalityId: PERSONALITY,
        id: entry.id,
      });
      expect(rejected.body.ok).toBe(true);
    });
  });

  describe('memory: markdown (unchanged)', () => {
    const config: MemoryBackendSelection = {};

    beforeEach(async () => {
      await boot(config);
    });

    it('editor, Timeline, approve, and restore all stay at dataDir', async () => {
      const scopeDir = join(dataDir, 'personalities', PERSONALITY);
      await call('write', {
        store: 'memory',
        content: 'markdown note',
        personalityId: PERSONALITY,
      });
      expect(await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8')).toContain('markdown note');

      const { store: queue } = createPendingMemoryStore({ dataDir, storage, config });
      const entry = await queue.propose({
        scopeId: SCOPE,
        source: 'capture',
        factHash: 'h-md',
        update: { action: 'add', key: 'MEMORY.md', content: 'approved note' },
      });
      await call('pendingApprove', { personalityId: PERSONALITY, id: entry.id });
      const file = await call<{ file: { content: string } }>('get', {
        store: 'memory',
        personalityId: PERSONALITY,
      });
      expect(file.body.file.content).toContain('approved note');

      const iso = new Date().toISOString();
      await writeFile(
        join(scopeDir, 'memory-archive.md'),
        `<!-- archived ${iso} slug=legacy from=MEMORY.md -->\n### legacy\n\nOld detail.`,
      );
      const restored = await call<{ restoredTo: string }>('restore', {
        personalityId: PERSONALITY,
        slug: 'legacy',
      });
      expect(restored.body.restoredTo).toBe('MEMORY.md');
      expect(await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8')).toContain('### legacy');

      const history = await call<{ entries: Array<{ source: string }> }>('history', {
        personalityId: PERSONALITY,
      });
      expect(new Set(history.body.entries.map((e) => e.source))).toEqual(
        new Set(['web-editor', 'capture', 'restore']),
      );
      expect(await storage.exists(join(scopeDir, 'memory-history.jsonl'))).toBe(true);
    });
  });
});
