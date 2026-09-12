// F06 (plan/phases/architecture-suggestions-2026-09-10.md) — the desktop stops
// and restarts its backend inside ONE Electron main process. `stopServer` used
// to close call capture, the WS lanes and the HTTP server, and nothing else: the
// web API's dashboard scheduler and the loop's background executor, reconciler
// and stores all survived, so every restart left the previous runtime running
// beside the new one. `startServer` needs a live Electron main process, so the
// release is its own module (`shutdownDesktopRuntime`), tested here directly —
// against a REAL `createWebApi` for the start-stop-start case.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import { createWebApi } from '@ethosagent/web-api';
import { createMemoryBundle } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DesktopRuntime, shutdownDesktopRuntime } from '../runtime-shutdown';

function recordingRuntime(order: string[]): DesktopRuntime {
  const step = (label: string) => async () => {
    order.push(label);
  };
  return {
    settleApprovals: () => void order.push('approvals'),
    closeChat: step('chat'),
    callCapture: { stop: step('call capture') },
    sockets: [{ close: step('voice') }, { close: step('satellite') }, { close: step('takeover') }],
    server: {
      close: (cb?: () => void) => {
        order.push('http');
        cb?.();
      },
    },
    webApi: { dispose: step('web api') },
    loop: { dispose: step('loop') },
    sessionStore: { close: () => void order.push('sessions.db') },
  };
}

describe('shutdownDesktopRuntime (F06)', () => {
  it('settles approvals first, stops intake, then the web API, the loop, the store', async () => {
    const order: string[] = [];
    await shutdownDesktopRuntime(recordingRuntime(order));
    // Chat right after approvals and BEFORE the server: `closeChat` writes the
    // "not sent" notice onto the tabs' SSE streams the server close then drops.
    expect(order).toEqual([
      'approvals',
      'chat',
      'call capture',
      'voice',
      'satellite',
      'takeover',
      'http',
      'web api',
      'loop',
      'sessions.db',
    ]);
  });

  it('attempts every step when one throws, then rejects with an AggregateError', async () => {
    const order: string[] = [];
    const runtime = recordingRuntime(order);
    runtime.webApi = {
      dispose: async () => {
        throw new Error('cards.db busy');
      },
    };
    const err = await shutdownDesktopRuntime(runtime).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('web api: cards.db busy');
    expect(order).toContain('loop');
    expect(order).toContain('sessions.db');
  });

  it('releases a half-built runtime — a start that failed after the loop was built', async () => {
    const order: string[] = [];
    await shutdownDesktopRuntime({
      loop: { dispose: async () => void order.push('loop') },
      sessionStore: { close: () => void order.push('sessions.db') },
    });
    expect(order).toEqual(['loop', 'sessions.db']);
  });
});

// F06 follow-up (live smoke) — `server.close()` waits on every open
// connection, and each desktop window holds `/sse/system` open, so a stop with
// the UI open never reached the web API or loop dispose behind it.
describe('shutdownDesktopRuntime with the UI still connected (F06)', () => {
  it('closes the HTTP server with an SSE stream open, then disposes', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: addr.port, path: '/sse/system' }, (res) => {
        res.on('data', () => {});
        res.on('error', () => {});
        resolve();
      });
      req.on('error', () => {});
      req.end();
    });

    const order: string[] = [];
    const started = Date.now();
    await shutdownDesktopRuntime({
      server,
      webApi: { dispose: async () => void order.push('web api') },
      loop: { dispose: async () => void order.push('loop') },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(server.listening).toBe(false);
    expect(order).toEqual(['web api', 'loop']);
  });

  it('gives up on a step that never settles, still runs the rest, and reports it', async () => {
    const order: string[] = [];
    const err = await shutdownDesktopRuntime(
      {
        loop: { dispose: () => new Promise<void>(() => {}) },
        sessionStore: { close: () => void order.push('sessions.db') },
      },
      { graceMs: 20 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('agent loop: did not finish within 20ms');
    expect(order).toEqual(['sessions.db']);
  });
});

describe('desktop stop → start leaves only the second runtime (F06)', () => {
  let dir: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    dir = await mkdtemp(join(tmpdir(), 'ethos-desktop-restart-'));
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  /** One backend the way `startServer` assembles it, minus Electron and the port. */
  function startRuntime(): { runtime: DesktopRuntime; loopDispose: ReturnType<typeof vi.fn> } {
    const loopDispose = vi.fn(async () => {});
    const loop = {
      hooks: new DefaultHookRegistry(),
      async *run() {},
    } as unknown as AgentLoop;
    const session = new SQLiteSessionStore(':memory:');
    const web = createWebApi({
      dataDir: dir,
      sessionStore: session,
      memoryBundle: createMemoryBundle({
        config: {},
        dataDir: dir,
        storage: new InMemoryStorage(),
      }),
      agentLoop: loop,
      personalities: new FilePersonalityRegistry(new FsStorage()),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
    return {
      loopDispose,
      runtime: {
        settleApprovals: web.forceSettleApprovals,
        sockets: [web.voiceSocket, web.satelliteSocket, web.takeoverSocket],
        webApi: { dispose: web.dispose },
        loop: { dispose: loopDispose },
        sessionStore: session,
      },
    };
  }

  it('the first runtime’s scheduler and loop are gone before the second starts', async () => {
    const a = startRuntime();
    expect(vi.getTimerCount()).toBe(1);

    await shutdownDesktopRuntime(a.runtime);
    expect(vi.getTimerCount()).toBe(0);
    expect(a.loopDispose).toHaveBeenCalledTimes(1);

    const b = startRuntime();
    expect(vi.getTimerCount()).toBe(1);
    await shutdownDesktopRuntime(b.runtime);
    expect(vi.getTimerCount()).toBe(0);
  });
});
