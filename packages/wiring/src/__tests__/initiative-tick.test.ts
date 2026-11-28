// Task 5.5: the scheduled tick. Real wiring factories, real SQLite ledger and read-only registry;
// only the LLM is scripted (no network). `clock` and the tick's `now` are fixed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPersonalityRegistry } from '@ethosagent/core';
import { InitiativeConfigService } from '@ethosagent/initiative-runner';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createInitiativeRuntime } from '../initiative-runtime';
import { createLazyInitiativeStore } from '../initiatives';

const T0 = new Date('2026-11-28T10:00:00Z');
const T1 = new Date('2026-11-28T10:05:00Z');
const T2 = new Date('2026-11-28T10:10:00Z');

function scriptedLLM(gate?: Promise<void>) {
  const state = { calls: 0 };
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      state.calls++;
      if (gate) await gate;
      yield {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.1,
        },
      };
      yield { type: 'text_delta', text: 'Nothing worth exploring yet.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, state };
}

let home: string;
let dataDir: string;
const closers: Array<{ close(): void }> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-initiative-tick-'));
  dataDir = join(home, '.ethos');
  for (const id of ['product-manager', 'writer']) {
    mkdirSync(join(dataDir, 'personalities', id), { recursive: true });
  }
});

afterEach(() => {
  while (closers.length) closers.pop()?.close();
  rmSync(home, { recursive: true, force: true });
});

function setup(opts: { gate?: Promise<void>; reloads?: string[] } = {}) {
  const storage = new FsStorage();
  const ledger = createLazyInitiativeStore({ storage, dataDir });
  closers.push(ledger);
  const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
  closers.push(session as unknown as { close(): void });
  const memory = new MarkdownFileMemoryProvider({ dir: dataDir, storage });
  const personalities = new DefaultPersonalityRegistry();
  for (const id of ['product-manager', 'writer']) {
    personalities.define({ id, name: id, toolset: ['web_search', 'memory_read'] });
  }
  const { llm, state } = scriptedLLM(opts.gate);
  const warnings: string[] = [];
  const runtime = createInitiativeRuntime({
    storage,
    dataDir,
    ledger,
    personalities,
    llm,
    safety: createTestSafety(),
    config: {},
    toolsConfig: () => undefined,
    memory,
    session,
    clock: () => T0,
    log: { warn: (m) => warnings.push(m) },
    enablement: {
      reload: async (id) => {
        opts.reloads?.push(id ?? '*');
      },
    },
  });
  const config = new InitiativeConfigService({
    storage,
    dataDir,
    store: ledger.store,
    constitution: async () => ({}),
    settings: async () => ({
      enabled: true,
      selfStart: false,
      dailyBudgetUsd: 0,
      standingGuidance: [],
    }),
    toolset: () => ['web_search'],
    schedule: () => {},
  });
  const save = async (personalityId: string, id: string) => {
    const r = await config.save({
      personalityId,
      op: 'create',
      sessionId: 'chat-1',
      confirmedBy: 'owner_chat',
      draft: {
        id,
        version: 1,
        origin: 'human',
        created_in: 'chat',
        state: 'active',
        title: id,
        outcome: 'learn something',
        sources: ['web'],
        exclude: [],
        guidance: [],
        autonomy: { mode: 'ask' },
        budget: { usd_per_day: 3, usd_per_exploration: 1, max_open_explorations: 3 },
        timeline: {
          explore_windows: ['every 6h'],
          window_minutes: 20,
          default_days: 7,
          review_on: '2026-12-20',
        },
        delivery: { owner_channel: 'telegram:1', digest_time: '09:00' },
      },
    });
    expect(r).toMatchObject({ ok: true });
  };
  return { storage, ledger, runtime, llm: state, save, warnings };
}

const writeConstitution = (body: string) => writeFileSync(join(dataDir, 'constitution.yaml'), body);
const writeSettings = (personalityId: string, enabled: boolean) => {
  const dir = join(dataDir, 'personalities', personalityId, 'initiatives');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.yaml'), `enabled: ${enabled}\n`);
};

describe('initiative tick', () => {
  it('$0 until a first initiative is saved', async () => {
    const { runtime, llm, storage } = setup();
    const report = await runtime.tick(T0);
    expect(report.skipped).toBe('no-ledger');
    expect(report.ran).toEqual([]);
    expect(llm.calls).toBe(0);
    expect(await storage.exists(join(dataDir, 'initiatives.db'))).toBe(false);
  });

  it('a new initiative gets one survey, then nothing until a window is due', async () => {
    const { runtime, llm, save } = setup();
    await save('product-manager', 'activation');
    const first = await runtime.tick(T0);
    expect(first.ran.map((r) => [r.initiativeId, r.kind])).toEqual([['activation', 'survey']]);
    expect(llm.calls).toBe(1);
    await runtime.tick(T1);
    expect(llm.calls).toBe(1);
  });

  it('enabled:false in the constitution stops every personality at the next tick', async () => {
    const reloads: string[] = [];
    const { runtime, llm, ledger, save } = setup({ reloads });
    await save('product-manager', 'activation');
    await save('writer', 'launch-posts');
    await runtime.tick(T0);
    expect(llm.calls).toBe(2);

    writeConstitution('initiatives:\n  enabled: false\n');
    const report = await runtime.tick(T1);

    expect([...report.paused].sort()).toEqual(['activation', 'launch-posts']);
    expect(ledger.store.getInitiative('activation')?.state).toBe('paused');
    expect(ledger.store.getInitiative('launch-posts')?.state).toBe('paused');
    expect(report.ran).toEqual([]);
    expect(llm.calls).toBe(2);
    // The chat tool list catches up with the same switch.
    expect(reloads).toEqual(['*', '*']);
  });

  it('turning a personality off pauses, turning it on resumes', async () => {
    const { runtime, ledger, save } = setup();
    await save('product-manager', 'activation');
    await save('product-manager', 'retention');
    await runtime.tick(T0);
    // The owner paused this one by hand; a switch-off and switch-on must not touch it.
    ledger.store.transitionInitiative('retention', 'paused', 'owner paused it');

    writeSettings('product-manager', false);
    const off = await runtime.tick(T1);
    expect(off.paused).toEqual(['activation']);
    expect(ledger.store.getInitiative('activation')?.state).toBe('paused');

    writeSettings('product-manager', true);
    const on = await runtime.tick(T2);
    expect(on.resumed).toEqual(['activation']);
    expect(ledger.store.getInitiative('activation')?.state).toBe('active');
    expect(ledger.store.getInitiative('retention')?.state).toBe('paused');
    // Files and ledger are kept: the initiative still has its survey window.
    expect(ledger.windows('activation').map((w) => w.kind)).toEqual(['survey']);
  });

  it('a tick in progress makes the next one skip', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime, llm, save } = setup({ gate });
    await save('product-manager', 'activation');
    const running = runtime.tick(T0);
    await new Promise((r) => setTimeout(r, 50));
    expect((await runtime.tick(T1)).skipped).toBe('busy');
    release();
    expect((await running).ran).toHaveLength(1);
    expect(llm.calls).toBe(1);
  }, 30_000);

  it('dispose stops further ticks and is idempotent', async () => {
    const { runtime, llm, save } = setup();
    await save('product-manager', 'activation');
    runtime.dispose();
    runtime.dispose();
    expect((await runtime.tick(T0)).skipped).toBe('disposed');
    expect(llm.calls).toBe(0);
  });
});
