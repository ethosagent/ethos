import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// `sessions.contextAnatomy` carries the context-meter fields (memory, skills,
// promptTokens, contextWindow, compactAtTokens) end-to-end through the contract.

const anatomy: ContextAnatomyWire = {
  system: 1000,
  tools: 200,
  messages: 50,
  total: 1250,
  inputTokens: 10,
  cacheReadTokens: 80_000,
  cacheHitRate: 0.9,
  llmCallCount: 3,
  memory: 250,
  skills: 100,
  promptTokens: 80_310,
  contextWindow: null,
  compactAtTokens: 150_000,
};

describe('sessions.contextAnatomy RPC', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let cookie: string;

  async function boot() {
    const app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      contextAnatomyFn: () => anatomy,
    }).app;
    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    return app;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-anatomy-rpc-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('round-trips all 13 anatomy fields, including a null contextWindow', async () => {
    const session = await store.createSession({
      key: 'web:anatomy',
      platform: 'web',
      model: 'm',
      provider: 'p',
      personalityId: 'agent-a',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    } as never);
    const app = await boot();
    const res = await app.request('/rpc/sessions/contextAnatomy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: { id: session.id } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { anatomy: ContextAnatomyWire } };
    expect(Object.keys(body.json.anatomy)).toHaveLength(13);
    expect(body.json.anatomy).toEqual(anatomy);
  });
});
