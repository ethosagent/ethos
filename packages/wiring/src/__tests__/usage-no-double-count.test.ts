// plan background-usage-accounting §5.5 — THE no-double-count invariant, driven
// through the real composition root (`createAgentLoop`) on a throwaway
// `~/.ethos`. Every model call reports a distinct cost, so a call counted twice
// or not at all moves a total by an amount that names it:
//
//   main turn call         1.00  → a `messages` row (never the ledger)
//   tool `ctx.llm`         0.10  → ledger `tool_llm`
//   memory flush           0.01  → ledger `memory_flush`
//   injection classifier   0.001 → ledger `injection_classifier`
//
// Turn 1 reads untrusted content (the classifier runs); a tainted run never
// flushes (`runMemoryFlush`, packages/core/src/agent-loop/turn-end.ts), so the
// flush is turn 2's. The provider's `complete` is stubbed on the prototype, so
// no network call is made.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import Database from '@ethosagent/sqlite';
import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';
import { usageChunk } from './helpers/usage-test-kit';

const MAIN = 1;
const TOOL_LLM = 0.1;
const FLUSH = 0.01;
const CLASSIFIER = 0.001;

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-usage-no-double-count-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const usage = (cost: number) => usageChunk(100, 10, cost);

/** Routes each call by what it is; main calls ask for the probe tool once per turn. */
function stubProvider(): void {
  vi.spyOn(AnthropicProvider.prototype, 'complete').mockImplementation(async function* (
    messages: Message[],
    _tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncGenerator<CompletionChunk> {
    if (options.system?.includes('injection-detection classifier')) {
      yield { type: 'text_delta', text: '{"containsInstructions": false, "confidence": 0.9}' };
      yield usage(CLASSIFIER);
      yield { type: 'done', finishReason: 'end_turn' };
      return;
    }
    if (options.system?.includes('silent background memory maintenance')) {
      yield { type: 'text_delta', text: 'nothing to save' };
      yield usage(FLUSH);
      yield { type: 'done', finishReason: 'end_turn' };
      return;
    }
    if (messages[0]?.content === 'TOOL PROBE') {
      yield { type: 'text_delta', text: 'a summary' };
      yield usage(TOOL_LLM);
      yield { type: 'done', finishReason: 'end_turn' };
      return;
    }
    const last = messages[messages.length - 1];
    const wantsTool =
      last?.role === 'user' && typeof last.content === 'string' && last.content === 'read it';
    if (wantsTool) {
      yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'probe_tool' };
      yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
      yield usage(MAIN);
      yield { type: 'done', finishReason: 'tool_use' };
      return;
    }
    yield { type: 'text_delta', text: 'done' };
    yield usage(MAIN);
    yield { type: 'done', finishReason: 'end_turn' };
  });
}

/** Calls `ctx.llm`, then returns untrusted content long enough for tier-2 classification. */
const probeTool: Tool = {
  name: 'probe_tool',
  description: 'reads an untrusted page and summarizes it with ctx.llm',
  capabilities: {},
  alwaysInclude: true,
  outputIsUntrusted: true,
  schema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const summary = (await ctx.llm?.complete('TOOL PROBE')) ?? '';
    return { ok: true, value: `${summary} ${'untrusted page text. '.repeat(40)}` };
  },
};

const config: WiringConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-test',
  compaction: { autoCompact: false },
  memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 1 },
};

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) {
    // drain to exhaustion: the flush runs after `done`
  }
}

function ledgerRows(dataDir: string): { kind: string; cost: number; key: string | null }[] {
  const db = new Database(join(dataDir, 'sessions.db'));
  try {
    return db
      .prepare(
        'SELECT source_kind AS kind, estimated_cost_usd AS cost, session_key AS key FROM usage_ledger ORDER BY ts, rowid',
      )
      .all() as { kind: string; cost: number; key: string | null }[];
  } finally {
    db.close();
  }
}

function messagesCost(dataDir: string): number {
  const db = new Database(join(dataDir, 'sessions.db'));
  try {
    const row = db
      .prepare('SELECT COALESCE(SUM(estimated_cost_usd), 0) AS c FROM messages')
      .get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe('usage: no double counting (§5.5)', () => {
  it('main calls land in messages, utility calls in the ledger, each exactly once', async () => {
    stubProvider();
    const dataDir = mkdtempSync(join(home, 'data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ETHOS_STATE_DIR = dataDir;
    const result = await createAgentLoop(config, {
      dataDir,
      workingDir: home,
      disableDocker: true,
    });
    const sessionKey = 'cli:no-double-count';
    try {
      result.toolRegistry.register(probeTool);

      await drain(result.loop.run('read it', { sessionKey }));
      await drain(result.loop.run('anything to remember?', { sessionKey }));

      const rows = ledgerRows(dataDir);
      expect(rows.map((r) => r.kind).sort()).toEqual(
        ['injection_classifier', 'memory_flush', 'tool_llm'].sort(),
      );
      expect(rows.every((r) => r.key === sessionKey)).toBe(true);
      expect(messagesCost(dataDir)).toBeCloseTo(3 * MAIN, 9);

      const expected = 3 * MAIN + TOOL_LLM + FLUSH + CLASSIFIER;
      expect(result.loop.getSessionCost(sessionKey)).toBeCloseTo(expected, 9);
    } finally {
      await result.dispose();
    }

    const store = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
    try {
      const day = await store.usageAggregate({
        since: new Date(Date.now() - 3_600_000),
        until: new Date(Date.now() + 3_600_000),
        dimension: 'day',
      });
      const total = day.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
      expect(total).toBeCloseTo(3 * MAIN + TOOL_LLM + FLUSH + CLASSIFIER, 9);
    } finally {
      store.close();
    }
  });

  it('a replay arm records its main call to the ledger as learning_replay, never to messages', async () => {
    stubProvider();
    const dataDir = mkdtempSync(join(home, 'data-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.ETHOS_STATE_DIR = dataDir;
    const replaySession = new InMemorySessionStore();
    const result = await createAgentLoop(config, {
      dataDir,
      workingDir: home,
      disableDocker: true,
      replay: {
        storage: new (await import('@ethosagent/storage-fs')).FsStorage(),
        session: replaySession,
      },
    });
    try {
      await drain(result.loop.run('just answer', { sessionKey: 'replay:c1:baseline:k1' }));
    } finally {
      await result.dispose();
    }
    expect(ledgerRows(dataDir).map((r) => r.kind)).toEqual(['learning_replay']);
    expect(messagesCost(dataDir)).toBe(0);
  });
});
