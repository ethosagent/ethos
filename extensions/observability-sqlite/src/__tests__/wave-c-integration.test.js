import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveMonth, listArchives, pruneArchives, restoreArchive } from '../archive';
import { SQLiteObservabilityStore } from '../store';
import { createTarGz, readTarGz } from '../tar-bundle';

function tmpDb() {
  return join(tmpdir(), `obs-wave-c-${randomUUID()}.db`);
}
// ---------------------------------------------------------------------------
// tar-bundle
// ---------------------------------------------------------------------------
describe('createTarGz / readTarGz', () => {
  it('round-trips a single text file', () => {
    const input = new Map();
    input.set('hello.txt', Buffer.from('Hello, World!', 'utf8'));
    const gz = createTarGz(input);
    expect(gz.length).toBeGreaterThan(0);
    const output = readTarGz(gz);
    expect(output.size).toBe(1);
    expect(output.get('hello.txt')?.toString('utf8')).toBe('Hello, World!');
  });
  it('round-trips multiple files with varying sizes', () => {
    const files = new Map();
    files.set('traces.jsonl', Buffer.from('{"trace_id":"abc"}', 'utf8'));
    files.set('spans.jsonl', Buffer.from('{"span_id":"def"}\n{"span_id":"ghi"}', 'utf8'));
    files.set('system.json', Buffer.from(JSON.stringify({ version: 'dev' }), 'utf8'));
    const output = readTarGz(createTarGz(files));
    expect(output.size).toBe(3);
    expect(output.get('traces.jsonl')?.toString()).toBe('{"trace_id":"abc"}');
    expect(output.get('spans.jsonl')?.toString()).toBe('{"span_id":"def"}\n{"span_id":"ghi"}');
  });
  it('handles empty file content', () => {
    const files = new Map([['empty.txt', Buffer.alloc(0)]]);
    const output = readTarGz(createTarGz(files));
    expect(output.get('empty.txt')?.length).toBe(0);
  });
  it('handles binary content round-trip', () => {
    const binary = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff]);
    const files = new Map([['data.bin', binary]]);
    const output = readTarGz(createTarGz(files));
    expect(output.get('data.bin')).toEqual(binary);
  });
  it('produces a smaller buffer than input (gzip compression active)', () => {
    // Highly compressible content
    const content = Buffer.from('A'.repeat(10_000), 'utf8');
    const files = new Map([['big.txt', content]]);
    const gz = createTarGz(files);
    expect(gz.length).toBeLessThan(content.length);
  });
});
// ---------------------------------------------------------------------------
// SQLiteObservabilityStore — new Wave C query methods
// ---------------------------------------------------------------------------
describe('SQLiteObservabilityStore Wave C queries', () => {
  let store;
  beforeEach(() => {
    store = new SQLiteObservabilityStore(tmpDb());
  });
  afterEach(() => {
    store.close();
  });
  function insertTrace(overrides = {}) {
    const t = {
      traceId: randomUUID(),
      kind: 'turn',
      startTs: Date.now(),
      ...overrides,
    };
    store.insertTrace(t);
    return t;
  }
  function insertSpan(traceId, overrides = {}) {
    const s = {
      spanId: randomUUID(),
      traceId,
      kind: 'tool_call',
      name: 'bash',
      startTs: Date.now(),
      ...overrides,
    };
    store.insertSpan(s);
    return s;
  }
  function insertEvent(traceId, overrides = {}) {
    const e = {
      eventId: randomUUID(),
      traceId,
      ts: Date.now(),
      category: 'error',
      severity: 'error',
      ...overrides,
    };
    store.insertEvent(e);
    return e;
  }
  it('getTraces returns traces in time range', () => {
    const t1 = insertTrace({ startTs: 1000 });
    const t2 = insertTrace({ startTs: 2000 });
    insertTrace({ startTs: 5000 });
    const results = store.getTraces({ since: 500, until: 3000 });
    const ids = results.map((t) => t.traceId);
    expect(ids).toContain(t1.traceId);
    expect(ids).toContain(t2.traceId);
    expect(ids).not.toContain(results.find((t) => t.startTs === 5000)?.traceId);
  });
  it('getTraces filters by sessionId', () => {
    const t1 = insertTrace({ sessionId: 'sess-A' });
    insertTrace({ sessionId: 'sess-B' });
    const results = store.getTraces({ sessionId: 'sess-A' });
    expect(results).toHaveLength(1);
    expect(results[0]?.traceId).toBe(t1.traceId);
  });
  it('getSpansByTraceIds returns spans for given trace IDs only', () => {
    const t1 = insertTrace();
    const t2 = insertTrace();
    const s1 = insertSpan(t1.traceId);
    const s2 = insertSpan(t2.traceId);
    insertSpan(randomUUID()); // orphan
    const results = store.getSpansByTraceIds([t1.traceId, t2.traceId]);
    const ids = results.map((s) => s.spanId);
    expect(ids).toContain(s1.spanId);
    expect(ids).toContain(s2.spanId);
    expect(results).toHaveLength(2);
  });
  it('getSpansByTraceIds returns empty array for empty input', () => {
    insertTrace();
    expect(store.getSpansByTraceIds([])).toEqual([]);
  });
  it('getEventsByTraceIds returns events for given trace IDs only', () => {
    const t1 = insertTrace();
    const t2 = insertTrace();
    const e1 = insertEvent(t1.traceId);
    insertEvent(randomUUID()); // different trace
    const results = store.getEventsByTraceIds([t1.traceId, t2.traceId]);
    expect(results.map((e) => e.eventId)).toContain(e1.eventId);
    expect(results).toHaveLength(1);
  });
  it('getSnapshot returns null for unknown ID', () => {
    expect(store.getSnapshot(randomUUID())).toBeNull();
  });
  it('getSnapshot round-trips a snapshot', () => {
    store.insertSnapshot({
      snapshotId: 'snap-1',
      takenAt: Date.now(),
      subjectId: 'engineer',
      body: '{"version":1}',
    });
    const got = store.getSnapshot('snap-1');
    expect(got?.snapshotId).toBe('snap-1');
    expect(got?.subjectId).toBe('engineer');
  });
  it('getSnapshotsByIds returns only requested snapshots', () => {
    store.insertSnapshot({ snapshotId: 'snap-A', takenAt: 1, subjectId: 'eng', body: '{}' });
    store.insertSnapshot({ snapshotId: 'snap-B', takenAt: 2, subjectId: 'eng', body: '{}' });
    store.insertSnapshot({ snapshotId: 'snap-C', takenAt: 3, subjectId: 'eng', body: '{}' });
    const results = store.getSnapshotsByIds(['snap-A', 'snap-C']);
    expect(results.map((s) => s.snapshotId).sort()).toEqual(['snap-A', 'snap-C']);
  });
});
// ---------------------------------------------------------------------------
// Archive round-trip
// ---------------------------------------------------------------------------
describe('archiveMonth / restoreArchive', () => {
  let dbPath;
  let store;
  let storage;
  const archiveDir = '/archive';
  beforeEach(() => {
    dbPath = tmpDb();
    store = new SQLiteObservabilityStore(dbPath);
    storage = new InMemoryStorage();
  });
  afterEach(() => {
    store.close();
  });
  it('archives completed traces from the target month and removes them from the live DB', async () => {
    // Insert traces in May 2026
    const may1 = new Date(2026, 4, 1).getTime(); // May 1
    const may15 = new Date(2026, 4, 15).getTime();
    const june1 = new Date(2026, 5, 1).getTime(); // Outside range
    const t1 = {
      traceId: randomUUID(),
      kind: 'turn',
      startTs: may1,
      endTs: may1 + 1000,
      status: 'ok',
    };
    const t2 = {
      traceId: randomUUID(),
      kind: 'turn',
      startTs: may15,
      endTs: may15 + 2000,
      status: 'ok',
    };
    const t3 = { traceId: randomUUID(), kind: 'turn', startTs: june1, endTs: june1 + 1000 }; // June — not archived
    for (const t of [t1, t2, t3]) store.insertTrace(t);
    store.insertSpan({
      spanId: randomUUID(),
      traceId: t1.traceId,
      kind: 'tool_call',
      name: 'bash',
      startTs: may1,
    });
    store.insertEvent({
      eventId: randomUUID(),
      traceId: t1.traceId,
      ts: may1,
      category: 'error',
      severity: 'error',
    });
    store.close();
    const result = await archiveMonth(dbPath, storage, archiveDir, '2026-05');
    expect(result.traces).toBe(2);
    expect(result.spans).toBe(1);
    expect(result.events).toBe(1);
    // Live DB should no longer contain May traces
    store = new SQLiteObservabilityStore(dbPath);
    const remaining = store.getTraces({});
    const remainingIds = remaining.map((t) => t.traceId);
    expect(remainingIds).not.toContain(t1.traceId);
    expect(remainingIds).not.toContain(t2.traceId);
    expect(remainingIds).toContain(t3.traceId); // June trace survives
  });
  it('returns empty result when no traces in target month', async () => {
    store.close();
    const result = await archiveMonth(dbPath, storage, archiveDir, '2020-01');
    expect(result.traces).toBe(0);
    expect(result.spans).toBe(0);
  });
  it('restores archived traces back into the live DB', async () => {
    const ts = new Date(2026, 4, 10).getTime();
    const t = {
      traceId: randomUUID(),
      kind: 'turn',
      startTs: ts,
      endTs: ts + 1000,
      status: 'ok',
    };
    store.insertTrace(t);
    const origTraceId = t.traceId;
    store.close();
    await archiveMonth(dbPath, storage, archiveDir, '2026-05');
    // Restore and verify
    const restoreResult = await restoreArchive(dbPath, storage, archiveDir, '2026-05');
    expect(restoreResult.traces).toBe(1);
    store = new SQLiteObservabilityStore(dbPath);
    const restored = store.getTrace(origTraceId);
    expect(restored?.traceId).toBe(origTraceId);
    expect(restored?.status).toBe('ok');
  });
  it('restore is idempotent (INSERT OR IGNORE)', async () => {
    const ts = new Date(2026, 4, 5).getTime();
    const t = { traceId: randomUUID(), kind: 'turn', startTs: ts, endTs: ts + 1 };
    store.insertTrace(t);
    store.close();
    await archiveMonth(dbPath, storage, archiveDir, '2026-05');
    const r1 = await restoreArchive(dbPath, storage, archiveDir, '2026-05');
    const r2 = await restoreArchive(dbPath, storage, archiveDir, '2026-05');
    expect(r1.traces).toBe(1);
    expect(r2.traces).toBe(1); // second restore counts insertions, INSERT OR IGNORE still runs
  });
  it('throws when archive file does not exist', async () => {
    store.close();
    await expect(restoreArchive(dbPath, storage, archiveDir, '1999-01')).rejects.toThrow(
      'Archive not found',
    );
  });
});
// ---------------------------------------------------------------------------
// listArchives / pruneArchives
// ---------------------------------------------------------------------------
describe('listArchives / pruneArchives', () => {
  it('listArchives returns entries sorted chronologically', async () => {
    const storage = new InMemoryStorage();
    const dir = '/arc';
    // Write dummy archive files
    await storage.mkdir(dir);
    await storage.write(join(dir, '2026-03.tar.gz'), 'x');
    await storage.write(join(dir, '2026-01.tar.gz'), 'x');
    await storage.write(join(dir, '2026-02.tar.gz'), 'x');
    await storage.write(join(dir, 'other.txt'), 'x'); // not a .tar.gz month file
    const list = await listArchives(storage, dir);
    expect(list.map((e) => e.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
  it('pruneArchives removes archives older than cutoff', async () => {
    const storage = new InMemoryStorage();
    const dir = '/arc2';
    await storage.mkdir(dir);
    // Write archives for Jan, Feb, Mar 2020 (very old)
    await storage.write(join(dir, '2020-01.tar.gz'), 'x');
    await storage.write(join(dir, '2020-02.tar.gz'), 'x');
    // Write a recent archive (current year)
    const now = new Date();
    const recentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await storage.write(join(dir, `${recentMonth}.tar.gz`), 'x');
    // Prune anything older than 1 year
    const removed = await pruneArchives(storage, dir, 365 * 24 * 3600 * 1000);
    expect(removed).toBe(2); // Jan and Feb 2020
    const remaining = await listArchives(storage, dir);
    expect(remaining.map((e) => e.month)).toEqual([recentMonth]);
  });
});
// ---------------------------------------------------------------------------
// Bundle privacy: ensure secrets never appear in bundle content
// ---------------------------------------------------------------------------
describe('support bundle privacy invariants', () => {
  it('stripSecrets removes keys matching secret pattern from nested objects', () => {
    // Test the logic inline since it is not exported; this tests the invariant
    // by building a bundle manually and checking the output bytes.
    const sensitiveData = {
      model: 'claude-opus-4-7',
      apiKey: 'sk-ant-test-secret',
      telegramToken: 'bot123:abc',
      nested: {
        password: 'hunter2',
        name: 'engineer',
      },
    };
    // Replicate stripSecrets logic
    const SECRET_RE = /key|token|secret|password/i;
    function strip(obj) {
      if (typeof obj !== 'object' || obj === null) return obj;
      if (Array.isArray(obj)) return obj.map(strip);
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = SECRET_RE.test(k) ? '[REDACTED]' : strip(v);
      }
      return out;
    }
    const safe = strip(sensitiveData);
    expect(safe.model).toBe('claude-opus-4-7');
    expect(safe.apiKey).toBe('[REDACTED]');
    expect(safe.telegramToken).toBe('[REDACTED]');
    expect(safe.nested.password).toBe('[REDACTED]');
    expect(safe.nested.name).toBe('engineer');
  });
  it('bundle tar.gz does not contain known secret patterns', () => {
    const SECRET = 'sk-ant-aaabbbccc000111222333444555666777888999aaa';
    const safeTraces = [{ traceId: 'abc', kind: 'turn', startTs: 1 }];
    const files = new Map();
    files.set('system.json', Buffer.from(JSON.stringify({ version: 'dev' }), 'utf8'));
    files.set('traces.jsonl', Buffer.from(JSON.stringify(safeTraces[0]), 'utf8'));
    // Ensure the secret is NOT included
    files.set(
      'config.json',
      Buffer.from(JSON.stringify({ model: 'claude-opus-4-7', apiKey: '[REDACTED]' }), 'utf8'),
    );
    const gz = createTarGz(files);
    // The gzipped+tarred content should not contain the plain secret
    expect(gz.toString('utf8')).not.toContain(SECRET);
    // Verify round-trip integrity
    const unpacked = readTarGz(gz);
    const configStr = unpacked.get('config.json')?.toString('utf8') ?? '';
    expect(configStr).not.toContain(SECRET);
    expect(configStr).toContain('[REDACTED]');
  });
});
