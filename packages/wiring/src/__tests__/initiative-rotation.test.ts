// Task 6.5 part 2: window rotation across ticks and restarts, and the digest marker's write order.
// LLM scripted (no network); fixed `now` per tick.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPersonalityRegistry } from '@ethosagent/core';
import { InitiativeConfigService } from '@ethosagent/initiative-runner';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createInitiativeRuntime } from '../initiative-runtime';
import { createLazyInitiativeStore } from '../initiatives';

const at = (hhmm: string) => new Date(`2026-11-28T${hhmm}:00Z`);

const llm: LLMProvider = {
  name: 'scripted',
  model: 'mock-model',
  maxContextTokens: 200_000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text: 'Nothing yet.' };
    yield { type: 'done', finishReason: 'end_turn' };
  },
  async countTokens() {
    return 1;
  },
};

let home: string;
let dataDir: string;
const closers: Array<{ close(): void }> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-initiative-rotation-'));
  dataDir = join(home, '.ethos');
  mkdirSync(join(dataDir, 'personalities', 'pm', 'initiatives'), { recursive: true });
});

afterEach(() => {
  while (closers.length) closers.pop()?.close();
  rmSync(home, { recursive: true, force: true });
});

function build(
  storage: Storage,
  ledger: ReturnType<typeof createLazyInitiativeStore>,
  notify?: never,
) {
  const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
  closers.push(session as unknown as { close(): void });
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'pm', name: 'pm', toolset: ['web_search'] });
  return createInitiativeRuntime({
    storage,
    dataDir,
    ledger,
    personalities,
    llm,
    safety: createTestSafety(),
    config: {},
    toolsConfig: () => undefined,
    memory: new MarkdownFileMemoryProvider({ dir: dataDir, storage }),
    session,
    clock: () => at('00:00'),
    log: { warn: (m: string) => process.stderr.write(`WARN ${m}\n`) },
    ...(notify ? { notify } : {}),
  });
}

async function seed(storage: Storage, ledger: ReturnType<typeof createLazyInitiativeStore>) {
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
  const r = await config.save({
    personalityId: 'pm',
    op: 'create',
    sessionId: 's',
    confirmedBy: 'owner_chat',
    draft: {
      id: 'grow',
      version: 1,
      origin: 'human',
      created_in: 'chat',
      state: 'active',
      title: 'grow',
      outcome: 'learn',
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
}

/** After the first tick: the loader has bound the exploration cap by then (an unbound cap is $0). */
function openTwo(ledger: ReturnType<typeof createLazyInitiativeStore>): [string, string] {
  const ids: string[] = [];
  for (const q of ['a', 'b']) {
    const e = ledger.store.propose({
      initiativeId: 'grow',
      ideaId: null,
      question: q,
      estimateUsd: 1,
      days: 3,
    });
    ledger.store.transitionExploration(e.id, 'exploring', 'test');
    ids.push(e.id);
  }
  return ids as [string, string];
}

const ran = (ledger: ReturnType<typeof createLazyInitiativeStore>) =>
  ledger
    .windows('grow')
    .filter((w) => w.kind === 'window')
    .map((w) => w.explorationId);

describe('window rotation', () => {
  it('two open explorations alternate across ticks', async () => {
    const storage = new FsStorage();
    const ledger = createLazyInitiativeStore({ storage, dataDir });
    closers.push(ledger);
    await seed(storage, ledger);
    const runtime = build(storage, ledger);
    await runtime.tick(at('00:30'));
    const [a, b] = openTwo(ledger);
    for (const t of ['06:01', '12:01', '18:01']) await runtime.tick(at(t));
    expect(ran(ledger)).toEqual([a, b, a]);
  });

  it('rotation survives a restart', async () => {
    const storage = new FsStorage();
    const ledger = createLazyInitiativeStore({ storage, dataDir });
    closers.push(ledger);
    await seed(storage, ledger);
    const first = build(storage, ledger);
    await first.tick(at('00:30'));
    const [a, b] = openTwo(ledger);
    await first.tick(at('06:01'));
    first.dispose();
    const second = build(storage, ledger); // a new process: lastRunAt starts empty
    for (const t of ['06:30', '12:01']) await second.tick(at(t));
    expect(ran(ledger)).toEqual([a, b]);
  });
});
