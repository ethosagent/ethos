import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import { createWebApi, WebTokenRepository } from '@ethosagent/web-api';
import { createMemoryBundle } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeListener, listenWithFallback } from '../serve-listen';

// F06 follow-up — `ChatService.close` tells a tab its queued messages were not
// sent, over that tab's SSE stream. Every host used to close the listener
// (dropping every SSE stream) BEFORE the web API's dispose emitted it, so no
// tab ever saw the notice. The order is now: settle approvals → `closeChat()`
// → `closeListener` (which gives in-flight writes a moment before dropping
// connections) → the rest of the disposal. Real server, real SSE client.

function parkedLoop(): AgentLoop {
  return {
    hooks: new DefaultHookRegistry(),
    async *run(_input: string, opts: { abortSignal: AbortSignal }): AsyncGenerator<AgentEvent> {
      await new Promise<void>((resolve) => {
        if (opts.abortSignal.aborted) return resolve();
        opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'error', error: 'Aborted', code: 'aborted' };
    },
  } as unknown as AgentLoop;
}

describe('shutdown order — the queued-message notice reaches the tab (F06)', () => {
  let dir: string;
  let store: SQLiteSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-shutdown-notice-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('closeChat() then closeListener(): the open SSE stream receives "not sent"', async () => {
    const created = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: createMemoryBundle({
        config: {},
        dataDir: dir,
        storage: new InMemoryStorage(),
      }),
      agentLoop: parkedLoop(),
      personalities: new FilePersonalityRegistry(new FsStorage()),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
    const { server } = await listenWithFallback(created.app, 0, 1);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;

    const token = await new WebTokenRepository({
      dataDir: dir,
      storage: new FsStorage(),
    }).getOrCreate();
    const exchange = await fetch(`${base}/auth/exchange?t=${token}`, { redirect: 'manual' });
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const send = async (text: string, sessionId?: string) => {
      const res = await fetch(`${base}/rpc/chat/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: base },
        body: JSON.stringify({
          json: { clientId: 'tab', text, ...(sessionId ? { sessionId } : {}) },
        }),
      });
      return ((await res.json()) as { json: { sessionId: string } }).json;
    };

    const { sessionId } = await send('long task');
    let received = '';
    await new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: addr.port,
          path: `/sse/sessions/${sessionId}`,
          headers: { cookie },
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            received += chunk;
          });
          res.on('error', () => {});
          resolve();
        },
      );
      req.on('error', () => {});
      req.end();
    });
    await send('queued behind it', sessionId);

    await created.closeChat();
    await closeListener(server);
    await created.dispose();

    expect(received).toMatch(/not sent/);
  });
});
