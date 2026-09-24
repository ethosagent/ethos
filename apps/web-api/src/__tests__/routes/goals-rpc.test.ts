import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { InMemoryGoalStore, recordingExecutor } from '../../services/__tests__/in-memory-goals';
import type { GoalsBackend } from '../../services/goals.service';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// F05 over the wire: `createWebApi` hands its caller's goal pair to
// GoalsService, and a refusal when nothing can execute a goal reaches the
// client as `NOT_CONFIGURED` with 503 (middleware/error-envelope.ts
// STATUS_BY_CODE) — a precondition of this server, not a crash.

describe('goals RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-goals-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    sessions.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function boot(goals?: GoalsBackend) {
    const { app } = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      ...(goals ? { goals } : {}),
    });
    const token = await new WebTokenRepository({ dataDir, storage: new FsStorage() }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    return (method: string, input: unknown) =>
      app.request(`/rpc/goals/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
        },
        body: JSON.stringify({ json: input }),
      });
  }

  it('create is refused with 503 NOT_CONFIGURED when no goal backend is wired', async () => {
    const call = await boot();
    const res = await call('create', { personalityId: 'p', goalText: 'Review this repo' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { json: { code: string; message: string } };
    expect(body.json.code).toBe('NOT_CONFIGURED');
    expect(body.json.message).toContain('Goal execution is not available');
  });

  it('create runs on the pair createWebApi was given', async () => {
    const store = new InMemoryGoalStore();
    const executor = recordingExecutor({ canExecute: true });
    const call = await boot({ store, executor });

    const res = await call('create', { personalityId: 'p', goalText: 'Review this repo' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { goal: { id: string } } };
    expect(executor.started).toEqual([body.json.goal.id]);
    expect(store.get(body.json.goal.id)).not.toBeNull();
  });
});
