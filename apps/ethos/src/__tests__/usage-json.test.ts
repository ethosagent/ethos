import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SQLiteUsageLedger } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDuration, runUsage } from '../commands/usage';

// ---------------------------------------------------------------------------
// parseDuration unit tests
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('parses hours correctly', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('parses days correctly', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('parses minutes correctly', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
  });

  it('returns 0 for invalid format', () => {
    expect(parseDuration('invalid')).toBe(0);
  });

  it('returns 0 for zero hours', () => {
    expect(parseDuration('0h')).toBe(0);
  });

  it('returns 0 for missing unit', () => {
    expect(parseDuration('24')).toBe(0);
  });

  it('returns 0 for unsupported unit', () => {
    expect(parseDuration('2w')).toBe(0);
  });

  it('parses single-digit values', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1m')).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Aggregation logic tests via SQLiteSessionStore
// ---------------------------------------------------------------------------

const baseUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

describe('ethos usage aggregation', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    const dbPath = join(tmpdir(), `usage-test-${Date.now()}.db`);
    store = new SQLiteSessionStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it('listSessions with since filter returns only recent sessions', async () => {
    const now = new Date();
    const _old = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago

    // Insert an old session manually — created_at is set via upsert
    await store.createSession({
      key: 'cli:old',
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      usage: { ...baseUsage, inputTokens: 100, estimatedCostUsd: 0.01 },
    });

    // Insert a recent session
    await store.createSession({
      key: 'cli:recent',
      platform: 'cli',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      usage: { ...baseUsage, inputTokens: 200, estimatedCostUsd: 0.02 },
    });

    // Query with since = 1 hour ago — should see both since upsert sets created_at = now
    const since1h = new Date(now.getTime() - 60 * 60 * 1000);
    const results = await store.listSessions({ since: since1h, limit: 100 });
    expect(results.length).toBe(2);
  });

  it('aggregates tokens across sessions', async () => {
    await store.createSession({
      key: 'cli:a',
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      usage: { ...baseUsage, inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.05 },
    });

    await store.createSession({
      key: 'cli:b',
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      usage: { ...baseUsage, inputTokens: 300, outputTokens: 50, estimatedCostUsd: 0.03 },
    });

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const sessions = await store.listSessions({ since, limit: 100 });

    const totalInput = sessions.reduce((acc, s) => acc + s.usage.inputTokens, 0);
    const totalOutput = sessions.reduce((acc, s) => acc + s.usage.outputTokens, 0);
    const totalCost = sessions.reduce((acc, s) => acc + s.usage.estimatedCostUsd, 0);

    expect(totalInput).toBe(800);
    expect(totalOutput).toBe(150);
    expect(Math.round(totalCost * 100) / 100).toBe(0.08);
  });

  it('groups sessions by provider and model', async () => {
    await store.createSession({
      key: 'cli:a',
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      usage: { ...baseUsage, inputTokens: 100, estimatedCostUsd: 0.01 },
    });

    await store.createSession({
      key: 'cli:b',
      platform: 'cli',
      model: 'gpt-4o',
      provider: 'openai',
      usage: { ...baseUsage, inputTokens: 200, estimatedCostUsd: 0.02 },
    });

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const sessions = await store.listSessions({ since, limit: 100 });

    const providerMap = new Map<string, number>();
    for (const s of sessions) {
      const key = `${s.provider}:${s.model}`;
      providerMap.set(key, (providerMap.get(key) ?? 0) + s.usage.inputTokens);
    }

    expect(providerMap.get('anthropic:claude-opus-4-7')).toBe(100);
    expect(providerMap.get('openai:gpt-4o')).toBe(200);
  });

  it('groups sessions by personality', async () => {
    await store.createSession({
      key: 'cli:a',
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      personalityId: 'hermes',
      usage: { ...baseUsage, apiCallCount: 3, estimatedCostUsd: 0.01 },
    });

    await store.createSession({
      key: 'cli:b',
      platform: 'cli',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      personalityId: 'ethos',
      usage: { ...baseUsage, apiCallCount: 5, estimatedCostUsd: 0.02 },
    });

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const sessions = await store.listSessions({ since, limit: 100 });

    const personalityMap = new Map<string, number>();
    for (const s of sessions) {
      const pid = s.personalityId ?? 'unknown';
      personalityMap.set(pid, (personalityMap.get(pid) ?? 0) + s.usage.apiCallCount);
    }

    expect(personalityMap.get('hermes')).toBe(3);
    expect(personalityMap.get('ethos')).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// `--by source` (plan background-usage-accounting §6.2)
// ---------------------------------------------------------------------------

describe('ethos usage --by source', () => {
  let stateDir: string;
  const prevState = process.env.ETHOS_STATE_DIR;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'ethos-usage-source-'));
    process.env.ETHOS_STATE_DIR = stateDir;
    const dbPath = join(stateDir, 'sessions.db');
    const store = new SQLiteSessionStore(dbPath);
    const s = await store.createSession({
      key: 'cli:a',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: baseUsage,
    });
    await store.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'x',
      usage: { ...baseUsage, inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.5 },
    });
    store.close();
    const ledger = new SQLiteUsageLedger(dbPath);
    ledger.record({
      ts: new Date().toISOString(),
      kind: 'memory_capture',
      sourceClass: 'background',
      provider: 'p',
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.25,
      outcome: 'ok',
    });
    ledger.close();
  });

  afterEach(() => {
    if (prevState === undefined) Reflect.deleteProperty(process.env, 'ETHOS_STATE_DIR');
    else process.env.ETHOS_STATE_DIR = prevState;
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function capture(argv: string[]): Promise<{ out: string; lines: string[] }> {
    let out = '';
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    await runUsage(argv);
    return { out, lines };
  }

  it('JSON carries source rows with calls, and calls in totals', async () => {
    const { out } = await capture(['--since', '1d', '--by', 'source', '--json']);
    const body = JSON.parse(out) as {
      totals: { calls: number; messages: number; estimatedCostUsd: number };
      by: { dimension: string; rows: Array<{ key: string; calls: number; messages: number }> };
    };
    expect(body.by.dimension).toBe('source');
    const byKey = Object.fromEntries(body.by.rows.map((r) => [r.key, r]));
    expect(byKey.turn).toMatchObject({ calls: 0, messages: 1 });
    expect(byKey['background:memory_capture']).toMatchObject({ calls: 1, messages: 0 });
    expect(body.totals.calls).toBe(1);
    expect(body.totals.estimatedCostUsd).toBeCloseTo(0.75, 6);
  });

  it('text output prints a source breakdown and a Background header line', async () => {
    const { lines } = await capture(['--since', '1d', '--by', 'source']);
    const text = lines.join('\n');
    expect(text).toMatch(/Background\s+\$0\.25 \(1 calls\)/);
    expect(text).toContain('background:memory_capture: $0.25');
    expect(text).toContain('(1 calls | 0 messages)');
  });

  it('help text lists source, and an unknown dimension still exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(runUsage([])).rejects.toThrow('exit');
    expect(String(err.mock.calls[0]?.[0])).toContain('source');
    await expect(runUsage(['--since', '1d', '--by', 'bogus'])).rejects.toThrow('exit');
    expect(exit).toHaveBeenLastCalledWith(2);
  });
});
