// Tests the producer-side role translation in exportSessionsToEval: session-store
// roles (user|assistant|tool_result|system|user_steer) must be mapped to the eval
// schema's roles (user|assistant|tool), with `system` skipped, before the eval
// validator (parseEvalJsonl) is allowed to see them.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvalJsonl } from '@ethosagent/skill-evolver';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportSessionsToEval } from '../evolve';

let tmp: string;
let dbPath: string;
let outPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ethos-evolve-export-'));
  dbPath = join(tmp, 'sessions.db');
  outPath = join(tmp, 'out.eval.jsonl');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function seed() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      platform TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      personality_id TEXT,
      parent_session_id TEXT,
      working_dir TEXT,
      title TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      api_call_count INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_calls TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      estimated_cost_usd REAL,
      timestamp TEXT NOT NULL
    ) STRICT;
  `);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, key, platform, model, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-1', 'cli:demo', 'cli', 'model-x', 'anthropic', now, now);

  const insertMsg = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const ts = new Date().toISOString();
  insertMsg.run('m-user', 'sess-1', 'user', 'content-user', ts);
  insertMsg.run('m-assistant', 'sess-1', 'assistant', 'content-assistant', ts);
  insertMsg.run('m-tool', 'sess-1', 'tool_result', 'content-tool-result', ts);
  insertMsg.run('m-system', 'sess-1', 'system', 'content-system', ts);
  insertMsg.run('m-steer', 'sess-1', 'user_steer', 'content-user-steer', ts);

  db.close();
}

describe('exportSessionsToEval', () => {
  it('translates session roles into eval roles and skips system', async () => {
    seed();

    const wrote = await exportSessionsToEval(dbPath, outPath);
    expect(wrote).toBe(true);

    const contents = await readFile(outPath, 'utf-8');
    // parseEvalJsonl throws on bad records — the eval validator must accept all rows.
    const records = parseEvalJsonl(contents);

    const byContent = new Map(records.map((r) => [r.content, r.role]));
    expect(byContent.get('content-tool-result')).toBe('tool');
    expect(byContent.get('content-user-steer')).toBe('user');

    expect(records.some((r) => r.role === ('system' as never))).toBe(false);
    expect(records).toHaveLength(4);
  });
});
