// Plan session-db-repair 6.1: createSessionStore wires the store's onRowIssue
// callback to EthosObservability.recordStorageRowIssue.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { ObsEvent, ObservabilityWriter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore } from '../index';
import { EthosObservability } from '../observability/ethos-observability';
import { setSessionRowIssueSink } from '../session-row-issue-sink';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

function fakeObservability() {
  const events: Array<Omit<ObsEvent, 'eventId' | 'ts'>> = [];
  const writer = {
    recordEvent: (e: Omit<ObsEvent, 'eventId' | 'ts'>) => events.push(e),
    startTrace: () => 't',
    endTrace: () => undefined,
    startSpan: () => 's',
    endSpan: () => undefined,
    flush: () => undefined,
  } as unknown as ObservabilityWriter;
  return { events, observability: new EthosObservability(writer) };
}

describe('createSessionStore row-issue wiring', () => {
  const dirs: string[] = [];
  afterEach(() => {
    setSessionRowIssueSink(undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('createSessionStore wires onRowIssue to a storage.row_issue event, severity warn, no content', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wiring-row-issue-'));
    dirs.push(dataDir);
    const { events, observability } = fakeObservability();
    setSessionRowIssueSink((issue) => observability.recordStorageRowIssue(issue));
    const store = createSessionStore({ dataDir });
    try {
      const s = await store.createSession({
        key: 'cli:x',
        platform: 'cli',
        model: 'm',
        provider: 'p',
        workingDir: '/tmp',
        usage,
      });
      const secret = 'PRIVATE-MESSAGE-TEXT';
      await store.appendMessage({ sessionId: s.id, role: 'user', content: secret });
      const db = new Database(join(dataDir, 'sessions.db'));
      db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{bad', s.id);
      db.close();

      await store.getSessionByKey('cli:x');
      await store.getSessionByKey('cli:x'); // deduped: one event per row+column

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category: 'storage.row_issue',
        severity: 'warn',
        details: { table: 'sessions', id: s.id, column: 'metadata', reason: 'invalid_json' },
      });
      expect(JSON.stringify(events[0])).not.toContain(secret);
    } finally {
      store.close();
    }
  });

  it('with a throwing sink the store still tolerates the bad row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wiring-row-issue-'));
    dirs.push(dataDir);
    setSessionRowIssueSink(() => {
      throw new Error('sink down');
    });
    const store = createSessionStore({ dataDir });
    try {
      const s = await store.createSession({
        key: 'cli:y',
        platform: 'cli',
        model: 'm',
        provider: 'p',
        workingDir: '/tmp',
        usage,
      });
      const db = new Database(join(dataDir, 'sessions.db'));
      db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{bad', s.id);
      db.close();
      expect((await store.getSessionByKey('cli:y'))?.id).toBe(s.id);
    } finally {
      store.close();
    }
  });
});
