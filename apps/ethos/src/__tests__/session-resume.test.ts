import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveResumeSession } from '../commands/sessions';

// ---------------------------------------------------------------------------
// FW-2 — resolveResumeSession helper
// ---------------------------------------------------------------------------

const baseSession = {
  key: 'cli:default',
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

describe('resolveResumeSession', () => {
  let store: SQLiteSessionStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `resume-test-${Date.now()}.db`);
    store = new SQLiteSessionStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it('resolves --continue to the most recent session', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 'cli:a' });
    await store.updateSession(s1.id, { title: 'older' });
    const s2 = await store.createSession({ ...baseSession, key: 'cli:b' });
    await store.updateSession(s2.id, { title: 'newer' });

    const result = await resolveResumeSession(store, { type: 'continue' });
    expect(result?.id).toBe(s2.id);
  });

  it('returns null when --continue and no sessions exist', async () => {
    const result = await resolveResumeSession(store, { type: 'continue' });
    expect(result).toBeNull();
  });

  it('resolves --resume <id> by exact session id', async () => {
    const s = await store.createSession({ ...baseSession, key: 'cli:x' });
    const result = await resolveResumeSession(store, { type: 'resume', query: s.id });
    expect(result?.id).toBe(s.id);
  });

  it('resolves --resume <title> by exact title (case-insensitive)', async () => {
    const s = await store.createSession({ ...baseSession, key: 'cli:y', title: 'Auth Refactor' });
    const result = await resolveResumeSession(store, { type: 'resume', query: 'auth refactor' });
    expect(result?.id).toBe(s.id);
  });

  it('resolves --resume <fragment> by title fragment when unique', async () => {
    const s = await store.createSession({
      ...baseSession,
      key: 'cli:z',
      title: 'auth refactoring',
    });
    const result = await resolveResumeSession(store, { type: 'resume', query: 'refactor' });
    expect(result?.id).toBe(s.id);
  });

  it('throws when --resume <fragment> matches multiple sessions', async () => {
    await store.createSession({ ...baseSession, key: 'cli:1', title: 'auth feature one' });
    await store.createSession({ ...baseSession, key: 'cli:2', title: 'auth feature two' });
    await expect(
      resolveResumeSession(store, { type: 'resume', query: 'auth feature' }),
    ).rejects.toThrow(/multiple sessions/i);
  });

  it('returns null when --resume query does not match anything', async () => {
    const result = await resolveResumeSession(store, { type: 'resume', query: 'nonexistent' });
    expect(result).toBeNull();
  });
});
