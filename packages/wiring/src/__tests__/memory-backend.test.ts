// Backend-aware memory assembly (memory-lifecycle vault gaps): proves that
// under `memory: vault` the full write family — consolidation/decay, the
// approve-before-store gate's replay, and proactive capture — targets the
// vault fixture (content under `<vaultRoot>/<agentDir>/`, provenance history
// under `<agentDir>/.ethos-meta/`), never `~/.ethos`, while the gate machinery
// (pending queue + tombstones) stays rooted at `~/.ethos` so the CLI/web
// pending surfaces keep working unchanged.

import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import { MemoryCaptureRunner } from '@ethosagent/memory-capture';
import { HistoryStore } from '@ethosagent/memory-history';
import {
  emptyMeta,
  planConsolidation,
  resolveDecayParams,
  restoreArchivedSlug,
} from '@ethosagent/nightly-loop';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentDonePayload,
  LLMProvider,
  Logger,
  MemoryContext,
  Session,
  SessionStore,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createPendingMemoryStore } from '../index';
import {
  buildVaultBackend,
  composeGatedMemory,
  createMemoryBundle,
  createMemoryProviderFromConfig,
  createUndecoratedBackend,
} from '../memory-backend';

const DATA = '/root/.ethos';
const VAULT = '/vault';
const AGENT_ROOT = '/vault/Ethos';
const SCOPE_DIR = join(AGENT_ROOT, 'personalities', 'muse');
const META_SCOPE_DIR = join(AGENT_ROOT, '.ethos-meta', 'personalities', 'muse');
const NOW = 1_800_000_000_000;

const VAULT_CONFIG = { memory: 'vault' as const, memoryVault: { path: VAULT } };

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function ctx(over: Partial<MemoryContext> = {}): MemoryContext {
  return {
    scopeId: 'personality:muse',
    sessionId: 's1',
    sessionKey: 'nightly',
    platform: 'cli',
    workingDir: '/tmp',
    ...over,
  };
}

describe('createMemoryProviderFromConfig — nightly targets the configured backend', () => {
  it('defaults to markdown at dataDir (existing behavior for markdown/vector)', () => {
    const storage = new InMemoryStorage();
    const backend = createMemoryProviderFromConfig({ config: {}, dataDir: DATA, storage });
    expect(backend.memoryRoot).toBe(DATA);
  });

  it('consolidation + decay write into the vault fixture, history in .ethos-meta, nothing under ~/.ethos', async () => {
    const storage = new InMemoryStorage();
    const backend = createMemoryProviderFromConfig({
      config: VAULT_CONFIG,
      dataDir: DATA,
      storage,
      source: 'consolidation',
    });
    expect(backend.memoryRoot).toBe(AGENT_ROOT);

    const preRun = '### durable\nkeep this\n\n### trivia\nthrowaway detail';
    await storage.mkdir(SCOPE_DIR);
    await storage.write(join(SCOPE_DIR, 'MEMORY.md'), `${preRun}\n`);

    const plan = planConsolidation({
      current: { memory: preRun, user: '' },
      result: {
        memory: preRun,
        user: '',
        memorySections: [
          { slug: 'durable', content: 'keep this', score: 0.9 },
          { slug: 'trivia', content: 'throwaway detail', score: 0.01 },
        ],
        userSections: [],
        scored: true,
      },
      meta: emptyMeta(),
      params: resolveDecayParams(undefined, NOW),
    });
    expect(plan.archivedSlugs).toEqual(['trivia']);
    await backend.provider.sync(plan.updates, ctx());

    // Live file + archive both inside the vault scope dir.
    const memory = await storage.read(join(SCOPE_DIR, 'MEMORY.md'));
    expect(memory).toContain('durable');
    expect(memory).not.toContain('trivia');
    expect(await storage.read(join(SCOPE_DIR, 'memory-archive.md'))).toContain('trivia');

    // History JSONL under <agentRoot>/.ethos-meta, source-labelled.
    const { entries } = await backend.history.read('personality:muse');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.source === 'consolidation')).toBe(true);
    expect(await storage.exists(join(META_SCOPE_DIR, 'memory-history.jsonl'))).toBe(true);

    // The sidecar root/storage resolve inside the vault too.
    await backend.storage.writeAtomic(
      join(backend.memoryRoot, 'personalities', 'muse', 'memory-meta.json'),
      JSON.stringify(plan.nextMeta),
    );
    expect(await storage.read(join(SCOPE_DIR, 'memory-meta.json'))).toContain('durable');

    // Nothing leaked into ~/.ethos.
    expect(await storage.read(join(DATA, 'personalities', 'muse', 'MEMORY.md'))).toBeNull();
    expect(
      await storage.read(join(DATA, 'personalities', 'muse', 'memory-history.jsonl')),
    ).toBeNull();
  });
});

describe('composeGatedMemory over the vault backend (gate + history stack)', () => {
  it('parks gated writes in the ~/.ethos queue; approve replays through the VAULT with original source + approvedBy', async () => {
    const storage = new InMemoryStorage();
    const { base, history } = createUndecoratedBackend({
      selection: VAULT_CONFIG,
      dataDir: DATA,
      storage,
      logger: NOOP_LOGGER,
    });
    const { provider, pending } = composeGatedMemory({
      base,
      history,
      approval: { mode: 'automated' },
      dataDir: DATA,
      storage,
    });
    if (!pending) throw new Error('expected a pending store when the gate is on');

    // Dream-sourced write (gated in `automated` mode) → parked, no vault bytes.
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'dreamed fact' }],
      ctx({ sessionKey: 'dream:muse' }),
    );
    expect(await storage.read(join(SCOPE_DIR, 'MEMORY.md'))).toBeNull();
    expect(
      await storage.read(join(DATA, 'personalities', 'muse', 'memory-pending.jsonl')),
    ).toContain('dreamed fact');
    expect((await history.read('personality:muse')).entries).toHaveLength(0);

    // Approve → applied to the VAULT provider, history-recorded once in
    // .ethos-meta under the ORIGINAL source plus approvedBy.
    const [entry] = await pending.list('personality:muse');
    if (!entry) throw new Error('expected a parked candidate');
    const result = await pending.approve('personality:muse', entry.id, 'tester');
    expect(result.ok).toBe(true);
    expect(await storage.read(join(SCOPE_DIR, 'MEMORY.md'))).toContain('dreamed fact');
    const { entries } = await history.read('personality:muse');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('dream');
    expect(entries[0]?.approvedBy).toBe('tester');

    // Non-gated tool write flows straight through and is recorded once.
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'explicit tool fact' }],
      ctx({ sessionKey: 'cli' }),
    );
    expect(await storage.read(join(SCOPE_DIR, 'MEMORY.md'))).toContain('explicit tool fact');
    expect((await history.read('personality:muse')).entries).toHaveLength(2);
  });

  it('signals cap drops through the observability seam', async () => {
    const storage = new InMemoryStorage();
    const { base, history } = createUndecoratedBackend({
      selection: VAULT_CONFIG,
      dataDir: DATA,
      storage,
      logger: NOOP_LOGGER,
    });
    const drops: Array<{ scopeId: string; cap: number }> = [];
    const { provider } = composeGatedMemory({
      base,
      history,
      approval: { mode: 'automated', cap: 1 },
      dataDir: DATA,
      storage,
      observability: {
        onCapExceeded: ({ scopeId, cap }) => drops.push({ scopeId, cap }),
      },
    });
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'first' }],
      ctx({ sessionKey: 'dream:muse' }),
    );
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'second' }],
      ctx({ sessionKey: 'dream:muse' }),
    );
    expect(drops).toEqual([{ scopeId: 'personality:muse', cap: 1 }]);
  });
});

describe('createPendingMemoryStore — CLI/web approve path is backend-aware', () => {
  it('under memory: vault, approve replays into the vault (history in .ethos-meta); queue stays at ~/.ethos', async () => {
    const storage = new InMemoryStorage();
    const { store } = createPendingMemoryStore({
      dataDir: DATA,
      storage,
      config: VAULT_CONFIG,
    });
    const entry = await store.propose({
      scopeId: 'personality:muse',
      source: 'capture',
      factHash: 'h-cli',
      update: { action: 'add', key: 'MEMORY.md', content: 'prefers metric units' },
    });

    // Queue machinery parked at ~/.ethos; no vault bytes yet.
    expect(
      await storage.read(join(DATA, 'personalities', 'muse', 'memory-pending.jsonl')),
    ).toContain('prefers metric units');
    expect(await storage.read(join(SCOPE_DIR, 'MEMORY.md'))).toBeNull();

    const result = await store.approve('personality:muse', entry.id, 'cli');
    expect(result.ok).toBe(true);

    // Approved fact landed in the vault scope dir, history in .ethos-meta
    // under the ORIGINAL source plus approvedBy.
    expect(await storage.read(join(SCOPE_DIR, 'MEMORY.md'))).toContain('prefers metric units');
    const metaHistory = new HistoryStore({ dataDir: join(AGENT_ROOT, '.ethos-meta'), storage });
    const { entries } = await metaHistory.read('personality:muse');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('capture');
    expect(entries[0]?.approvedBy).toBe('cli');

    // Nothing landed under ~/.ethos memory files.
    expect(await storage.read(join(DATA, 'personalities', 'muse', 'MEMORY.md'))).toBeNull();
    expect(
      await storage.read(join(DATA, 'personalities', 'muse', 'memory-history.jsonl')),
    ).toBeNull();
  });
});

describe('createMemoryBundle — host surfaces follow the loop backend (F04)', () => {
  /** The runtime `vault` registry factory's stack (build-infrastructure). */
  function runtimeVault(storage: InMemoryStorage) {
    const { base, history } = buildVaultBackend({ vault: VAULT_CONFIG.memoryVault, storage });
    return composeGatedMemory({ base, history, dataDir: DATA, storage }).provider;
  }

  it('under memory: vault, editor + restore write where the agent reads, labelled per surface', async () => {
    const storage = new InMemoryStorage();
    const bundle = createMemoryBundle({ config: VAULT_CONFIG, dataDir: DATA, storage });
    expect(bundle.backend).toBe('vault');
    if (!bundle.editing.supported) throw new Error('vault supports file editing');

    await bundle.editing.editor.sync(
      [{ action: 'replace', key: 'MEMORY.md', content: 'Use the staging account' }],
      ctx({ sessionKey: '' }),
    );
    expect((await runtimeVault(storage).read('MEMORY.md', ctx()))?.content).toContain(
      'Use the staging account',
    );
    expect(await storage.read(join(DATA, 'personalities', 'muse', 'MEMORY.md'))).toBeNull();

    await storage.write(
      join(SCOPE_DIR, 'memory-archive.md'),
      `<!-- archived ${new Date().toISOString()} slug=old from=MEMORY.md -->\n### old\n\nkept`,
    );
    const restored = await restoreArchivedSlug(bundle.editing.restore, ctx(), 'old');
    expect(restored.ok).toBe(true);
    expect((await runtimeVault(storage).read('MEMORY.md', ctx()))?.content).toContain('### old');

    const { entries } = await bundle.editing.history.read('personality:muse');
    expect(new Set(entries.map((e) => e.source))).toEqual(new Set(['web-editor', 'restore']));
    expect(await storage.exists(join(META_SCOPE_DIR, 'memory-history.jsonl'))).toBe(true);
  });

  it('keeps the approve queue at dataDir and replays into the vault', async () => {
    const storage = new InMemoryStorage();
    const bundle = createMemoryBundle({ config: VAULT_CONFIG, dataDir: DATA, storage });
    const entry = await bundle.pending.propose({
      scopeId: 'personality:muse',
      source: 'capture',
      factHash: 'h-bundle',
      update: { action: 'add', key: 'MEMORY.md', content: 'approved via bundle' },
    });
    expect(
      await storage.read(join(DATA, 'personalities', 'muse', 'memory-pending.jsonl')),
    ).toContain('approved via bundle');
    await bundle.pending.approve('personality:muse', entry.id, 'web');
    expect((await runtimeVault(storage).read('MEMORY.md', ctx()))?.content).toContain(
      'approved via bundle',
    );
  });

  it('markdown (the default) keeps every surface at dataDir', async () => {
    const storage = new InMemoryStorage();
    const bundle = createMemoryBundle({ config: {}, dataDir: DATA, storage });
    expect(bundle.backend).toBe('markdown');
    if (!bundle.editing.supported) throw new Error('markdown supports file editing');
    await bundle.editing.editor.sync(
      [{ action: 'replace', key: 'MEMORY.md', content: 'markdown note' }],
      ctx(),
    );
    expect(await storage.read(join(DATA, 'personalities', 'muse', 'MEMORY.md'))).toContain(
      'markdown note',
    );
    expect(await storage.exists(join(DATA, 'personalities', 'muse', 'memory-history.jsonl'))).toBe(
      true,
    );
  });

  it('vector reports file editing as unsupported instead of editing dataDir markdown', () => {
    const bundle = createMemoryBundle({
      config: { memory: 'vector' },
      dataDir: DATA,
      storage: new InMemoryStorage(),
    });
    expect(bundle.backend).toBe('vector');
    expect(bundle.editing.supported).toBe(false);
    if (bundle.editing.supported) return;
    expect(bundle.editing.reason).toContain('"vector" memory backend has no file editor');
  });

  it("the bundle's approve queue caps + expires by config.memoryApproval, as the runtime gate does", async () => {
    const storage = new InMemoryStorage();
    const approval = { mode: 'automated' as const, cap: 1, ttlDays: 1 };
    const scope = 'personality:muse';
    const update = { action: 'add' as const, key: 'MEMORY.md', content: 'x' };

    // Cap: the second propose drops the first, exactly as the runtime queue would.
    const capped = createMemoryBundle({
      config: { ...VAULT_CONFIG, memoryApproval: approval },
      dataDir: DATA,
      storage,
    });
    await capped.pending.propose({ scopeId: scope, source: 'capture', update });
    await capped.pending.propose({ scopeId: scope, source: 'capture', update });
    expect(await capped.pending.list(scope)).toHaveLength(1);

    // TTL: a candidate parked two days ago is expired under ttlDays: 1 but
    // still live under the 30-day default.
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const ttlStorage = new InMemoryStorage();
    const { store: parker } = createPendingMemoryStore({
      dataDir: DATA,
      storage: ttlStorage,
      config: VAULT_CONFIG,
      now: () => twoDaysAgo,
    });
    await parker.propose({ scopeId: scope, source: 'capture', update });
    const defaults = createMemoryBundle({
      config: VAULT_CONFIG,
      dataDir: DATA,
      storage: ttlStorage,
    });
    expect(await defaults.pending.list(scope)).toHaveLength(1);
    const tuned = createMemoryBundle({
      config: { ...VAULT_CONFIG, memoryApproval: approval },
      dataDir: DATA,
      storage: ttlStorage,
    });
    expect(await tuned.pending.list(scope)).toHaveLength(0);
  });

  it('under memory: vector, approve refuses (the runtime never gates vector) and the candidate stays', async () => {
    const storage = new InMemoryStorage();
    const bundle = createMemoryBundle({ config: { memory: 'vector' }, dataDir: DATA, storage });
    const scope = 'personality:muse';
    const entry = await bundle.pending.propose({
      scopeId: scope,
      source: 'capture',
      factHash: 'h-leftover',
      update: { action: 'add', key: 'MEMORY.md', content: 'parked under markdown' },
    });

    await expect(bundle.pending.approve(scope, entry.id, 'web')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: expect.stringContaining('Cannot approve into the "vector" memory backend'),
    });
    expect(await storage.read(join(DATA, 'personalities', 'muse', 'MEMORY.md'))).toBeNull();
    expect(await bundle.pending.list(scope)).toHaveLength(1);

    // Reject still clears it (and tombstones the fact).
    expect((await bundle.pending.reject(scope, entry.id)).ok).toBe(true);
    expect(await bundle.pending.list(scope)).toHaveLength(0);
  });
});

describe('proactive capture under memory: vault', () => {
  it('captures into the vault and records history at .ethos-meta', async () => {
    const storage = new InMemoryStorage();
    const { base, history } = createUndecoratedBackend({
      selection: VAULT_CONFIG,
      dataDir: DATA,
      storage,
      logger: NOOP_LOGGER,
    });
    const llm: LLMProvider = {
      name: 'fake',
      model: 'fake-model',
      maxContextTokens: 100_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete() {
        yield { type: 'text_delta', text: 'USER|0.8|Has a daughter named Priya, born 2019.' };
      },
      async countTokens() {
        return 0;
      },
    };
    const session: SessionStore = {
      getSession: async (id: string) => ({ id, key: 'cli:ethos' }) as unknown as Session,
    } as unknown as SessionStore;
    const runner = new MemoryCaptureRunner({
      provider: base,
      history,
      session,
      llm,
      sanitize: (s) => s,
      logger: NOOP_LOGGER,
      nightlyConfigured: false,
      workingDir: DATA,
    });
    const hooks = new DefaultHookRegistry();
    runner.registerHook(hooks);
    const payload: AgentDonePayload = {
      sessionId: 's1',
      text: 'Congrats!',
      turnCount: 1,
      personalityId: 'muse',
      initialPrompt:
        'My daughter Priya was born in 2019 and I work as a staff engineer at Acme, please remember it.',
    };
    await hooks.fireVoid('agent_done', payload);
    await runner.whenIdle();

    // Durable fact landed in the vault scope dir, not ~/.ethos.
    expect(await storage.read(join(SCOPE_DIR, 'USER.md'))).toContain('Priya');
    expect(await storage.read(join(DATA, 'personalities', 'muse', 'USER.md'))).toBeNull();

    // Capture history recorded at the vault's .ethos-meta.
    const { entries } = await history.read('personality:muse');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('capture');
    expect(await storage.exists(join(META_SCOPE_DIR, 'memory-history.jsonl'))).toBe(true);
  });
});
