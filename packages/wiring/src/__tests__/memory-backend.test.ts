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
import { emptyMeta, planConsolidation, resolveDecayParams } from '@ethosagent/nightly-loop';
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
import {
  composeGatedMemory,
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
