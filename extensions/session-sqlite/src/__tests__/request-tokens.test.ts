// `usage.requestTokens` survives SQLite.
//
// Context assembly derives the next turn's measured static slice (system +
// tools) from the newest assistant row's `usage.requestTokens` (Phase 1c,
// `packages/core/src/agent-loop/stages/context-assembly.ts`). The store used to
// drop the field, so every CLI and gateway turn — both on this store — fell back
// to an estimate; only the in-memory store measured. The field now lives in
// three nullable INTEGER columns added by `SQLiteSessionStore.migrate()` with no
// `user_version` bump.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultContextEngineRegistry,
  DefaultHookRegistry,
  DropOldestEngine,
  estimateMessagesTokens,
  estimateTokens,
  InMemorySessionStore,
} from '@ethosagent/core';
import Database from '@ethosagent/sqlite';
import type {
  CompletionChunk,
  ContextEngineCompactInput,
  LLMProvider,
  Message,
  SessionStore,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { SQLiteSessionStore } from '../index';

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

const REQUEST_COLUMNS = [
  'request_system_tokens',
  'request_tools_tokens',
  'request_messages_tokens',
];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-request-tokens-'));
  dbPath = join(dir, 'sessions.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(path: string): number {
  const db = new Database(path);
  try {
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    return rows[0]?.user_version ?? -1;
  } finally {
    db.close();
  }
}

describe('SQLiteSessionStore — usage.requestTokens', () => {
  it('round-trips the request split on an assistant row, across a reopen', async () => {
    const a = new SQLiteSessionStore(dbPath);
    const s = await a.createSession({
      key: 'cli:rt',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: { ...zeroUsage },
    });
    await a.appendMessage({ sessionId: s.id, role: 'user', content: 'hi' });
    await a.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'ok',
      usage: {
        inputTokens: 1_234,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        requestTokens: { system: 900, tools: 300, messages: 34 },
      },
    });
    // No split → none read back (NULL is "not measured", never zeros).
    await a.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'ok2',
      usage: { ...zeroUsage, inputTokens: 7 },
    });
    a.close();

    const b = new SQLiteSessionStore(dbPath);
    const [, measured, unmeasured] = await b.getMessages(s.id);
    expect(measured?.usage?.requestTokens).toEqual({ system: 900, tools: 300, messages: 34 });
    expect(unmeasured?.usage).toBeDefined();
    expect(unmeasured?.usage && 'requestTokens' in unmeasured.usage).toBe(false);
    b.close();

    // Additive columns, no version bump: an older binary still opens the file.
    expect(userVersion(dbPath)).toBe(1);
  });

  it('migrates a sessions.db from before the columns existed, keeping its rows', async () => {
    // Build the pre-change shape: today's schema minus the three columns.
    const seed = new SQLiteSessionStore(dbPath);
    const s = await seed.createSession({
      key: 'cli:old',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: { ...zeroUsage },
    });
    seed.close();
    const raw = new Database(dbPath);
    for (const col of REQUEST_COLUMNS) raw.exec(`ALTER TABLE messages DROP COLUMN ${col}`);
    // A row written by the old binary, with the old INSERT column list.
    raw
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, estimated_cost_usd, timestamp)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('legacy-1', s.id, 'assistant', 'old reply', 500, 2, 0, 0, 0, new Date().toISOString());
    raw.close();
    expect(userVersion(dbPath)).toBe(1);

    const store = new SQLiteSessionStore(dbPath);
    const [legacy] = await store.getMessages(s.id);
    expect(legacy?.content).toBe('old reply');
    expect(legacy?.usage?.inputTokens).toBe(500);
    expect(legacy?.usage && 'requestTokens' in legacy.usage).toBe(false);
    await store.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'new reply',
      usage: { ...zeroUsage, inputTokens: 9, requestTokens: { system: 1, tools: 2, messages: 6 } },
    });
    const [, fresh] = await store.getMessages(s.id);
    expect(fresh?.usage?.requestTokens).toEqual({ system: 1, tools: 2, messages: 6 });
    store.close();
    expect(userVersion(dbPath)).toBe(1);

    // Rollback direction: the old binary's INSERT (no request columns) still
    // succeeds against the migrated file, and reads back as unmeasured.
    const old = new Database(dbPath);
    old
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, input_tokens, timestamp)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('legacy-2', s.id, 'assistant', 'after rollback', 3, new Date().toISOString());
    old.close();
    const reopened = new SQLiteSessionStore(dbPath);
    const rows = await reopened.getMessages(s.id);
    const after = rows.find((m) => m.id === 'legacy-2');
    expect(after?.usage && 'requestTokens' in after.usage).toBe(false);
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// End to end: turn 2 on a real SQLiteSessionStore uses the MEASURED static slice
// ---------------------------------------------------------------------------

// 32k window. A ~20k-token system prompt (80,000 chars) the provider counts as
// 22,000 tokens (a denser tokenizer than char/4), and two 4,000-token turns: the
// turn-2 pre-LLM gate fires, and the target it hands the engine depends on
// whether the static slice was measured (22,000) or estimated (~20,000).
const WINDOW = 32_768;
const MEASURED_SYSTEM = 22_000;

function reportingLLM(split: boolean): LLMProvider {
  return {
    name: 'ollama',
    model: 'llama3.2',
    maxContextTokens: WINDOW,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[], toolDefs) {
      const tools = estimateTokens(JSON.stringify(toolDefs));
      const msgs = estimateMessagesTokens(messages);
      const chunks: CompletionChunk[] = [
        { type: 'text_delta', text: 'ok' },
        {
          type: 'usage',
          usage: {
            inputTokens: MEASURED_SYSTEM + tools + msgs,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0,
            ...(split ? { requestTokens: { system: MEASURED_SYSTEM, tools, messages: msgs } } : {}),
          },
        },
        { type: 'done', finishReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
    async countTokens() {
      return 10;
    },
  };
}

/** Two turns; returns the `targetTokens` the turn-2 pre-LLM compaction passed. */
async function turnTwoTargets(session: SessionStore, split: boolean): Promise<number[]> {
  const seen: number[] = [];
  const contextEngines = new DefaultContextEngineRegistry();
  contextEngines.register({
    name: 'drop_oldest',
    async compact(input: ContextEngineCompactInput) {
      seen.push(input.targetTokens);
      return new DropOldestEngine().compact(input);
    },
  });
  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_prompt_build', async () => ({
    appendSystem: 'p'.repeat(80_000),
  }));
  const loop = new AgentLoop({
    llm: reportingLLM(split),
    session,
    safety: createTestSafety(),
    hooks,
    contextEngines,
  });
  const drain = async (text: string) => {
    for await (const _ of loop.run(text, { sessionKey: 'cli:measured' })) {
      // drain to exhaustion (turn-end maintenance runs after `done`)
    }
  };
  await drain(`one ${'a'.repeat(16_000)}`);
  expect(seen).toEqual([]);
  await drain(`two ${'b'.repeat(16_000)}`);
  return seen;
}

describe('AgentLoop on SQLiteSessionStore — actuals-first static slice', () => {
  it('turn 2 compacts with the static slice turn 1 measured, as the in-memory store does', async () => {
    const sqlite = new SQLiteSessionStore(dbPath);
    const onSqlite = await turnTwoTargets(sqlite, true);

    const inMemory = await turnTwoTargets(new InMemorySessionStore(), true);
    const unmeasured = await turnTwoTargets(new InMemorySessionStore(), false);

    expect(onSqlite).toHaveLength(1);
    expect(onSqlite).toEqual(inMemory);
    // Before the columns existed SQLite always landed here instead.
    expect(onSqlite).not.toEqual(unmeasured);

    // The stored assistant row carries the split turn 2 read back.
    const [session] = await sqlite.listSessions({ keyPrefix: 'cli:measured' });
    const rows = await sqlite.getMessages(session?.id ?? '');
    const firstReply = rows.find((m) => m.role === 'assistant');
    expect(firstReply?.usage?.requestTokens?.system).toBe(MEASURED_SYSTEM);
    sqlite.close();
  });
});
