import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { disposeBeforeExit } from '../../lib/dispose-before-exit';
import { closeListener, listenWithFallback } from '../serve-listen';

// F06 (plan architecture-suggestions-2026-09-10) — every runtime `ethos serve`,
// `ethos gateway` and `ethos boot` build is disposed on the way out: the web
// API first (it borrowed the loop), then the loop. `runServe`,
// `runGatewayStart` and `runBoot` are long-running composition roots that are
// not importable from a vitest run, so the wiring is asserted against source,
// like serve-goals-wiring.test.ts; the dispose behaviour itself is pinned in
// packages/wiring/src/__tests__/runtime-dispose.test.ts and
// apps/web-api/src/__tests__/web-api-dispose.test.ts.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');

/** The body of the first `const cleanup = …` after `from`. */
function cleanupAfter(src: string, from: number): string {
  const start = src.indexOf('const cleanup = async (): Promise<void> => {', from);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n    };\n', start) + 1);
}

describe('serve.ts — runtime disposal', () => {
  it('takes dispose off every loop-construction branch', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src.match(/disposeLoop = result\.dispose;/g) ?? []).toHaveLength(2);
    expect(src).toContain('dispose: teamDispose,');
    expect(src).toContain('disposeLoop = teamDispose;');
    // Team loops the web API builds carry their dispose into TeamLoopRegistry.
    expect(src).toContain('dispose: team.dispose,');
  });

  it('disposes the web API, then the loop, then its own sessions.db, on shutdown', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toMatch(/\['web api', webDispose\],\n\s+\['agent loop', disposeLoop\],/);
    // Both branches close their own sessions.db handles, after the loop.
    expect(
      src.match(
        /'sessions\.db',\n\s+async \(\) => \{\n\s+contextLog\.close\(\);\n\s+session\.close\(\);/g,
      ) ?? [],
    ).toHaveLength(2);
  });

  it('closes its listener with closeListener in both branches — never a bare server.close()', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain('const webShutdown = () => closeListener(server);');
    expect(src).toContain(']).then(() => closeListener(server));');
    expect(src).not.toMatch(/server\.close\(\(\) => resolve\(\)\)/);
  });

  // Behavioural: the two halves `cleanup` composes, driven for real — a
  // listener with a web UI tab's SSE stream open, then the runtime disposal.
  // Before the fix the first half never resolved, so the second never ran.
  it('with an SSE stream open, the listener closes and the dispose behind it runs', async () => {
    const sse = {
      fetch: () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    };
    const { server } = await listenWithFallback(sse, 0, 1);
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

    const disposeLoop = vi.fn(async () => {});
    const started = Date.now();
    await closeListener(server);
    await disposeBeforeExit([['agent loop', disposeLoop]], () => {});
    expect(disposeLoop).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('onboarding mode disposes the loop it booted lazily, after any boot in flight', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    const onboarding = src.indexOf('if (config === null) {');
    expect(onboarding).toBeGreaterThan(-1);
    expect(src.indexOf('disposeRealLoop = agentResult.dispose;', onboarding)).toBeGreaterThan(-1);
    const cleanup = cleanupAfter(src, onboarding);
    expect(cleanup).toContain("['web api', () => created.dispose()]");
    expect(cleanup).toContain('await bootInFlight;');
    expect(cleanup).toContain('await disposeRealLoop?.();');
    // Before the exit, never after it.
    expect(cleanup.indexOf('disposeBeforeExit(')).toBeLessThan(cleanup.indexOf('process.exit(0)'));
  });
});

// F06 follow-up (confirmation review) — `a2a/tasks.db` was the last store
// nobody closed: `SQLiteA2aTaskStore.close()` had zero callers, so every clean
// exit left `.ethos/a2a/tasks.db-wal` and `-shm` behind (earlier smokes only
// listed the top level of `.ethos`).
describe('serve.ts — the a2a task store and the signal guard', () => {
  it('clears the a2a retention timer and closes tasks.db on the way out', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain('clearInterval(a2a.retentionTimer);');
    expect(src).toContain("['a2a tasks.db', async () => a2a.taskStore.close()],");
    // After the runtimes that write through it, like the other host stores.
    const dispose = src.indexOf("['agent loop', disposeLoop],");
    expect(src.indexOf("['a2a tasks.db'", dispose)).toBeGreaterThan(dispose);
  });

  it('closes the team notify queue it opened', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    // Opened by the host, not inside the ACP builder, so the host can close it.
    expect(src).toContain(
      "const notifyQueue = teamFlag ? new SQLiteNotifyQueue(join(dir, 'notify-queue.db')) : undefined;",
    );
    expect(src).toContain("['notify-queue.db', async () => notifyQueue?.close()],");
  });

  it('runs its shutdown once however many signals arrive (both branches)', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    // The same memoised shape `boot.ts` uses: one promise, every caller awaits it.
    expect(src.match(/shuttingDown \?\?= \(async \(\) => \{/g) ?? []).toHaveLength(2);
    // …and both signals still reach it — the guard is in `cleanup`, not in
    // which signals are handled.
    expect(
      src.match(/process\.on\('SIG(?:TERM|INT)', \(\) => void cleanup\(\)\);/g) ?? [],
    ).toHaveLength(4);
  });
});

describe('gateway.ts / boot.ts — runtime disposal', () => {
  it('gateway disposes every bot loop and the system loop before exiting', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain('disposers: botLoopDisposers,');
    expect(src).toContain('dispose: disposeSystemLoop,');
    // The step may wrap extra per-host cleanups around it; what matters is
    // that the system loop's dispose runs inside the same bounded sequence.
    expect(src).toMatch(/'system loop',[\s\S]{0,300}disposeSystemLoop\(\)/);
  });

  it('boot disposes the web API, the live bot loops and the system loop, last', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const step = src.indexOf("await guard('runtime-dispose'");
    expect(step).toBeGreaterThan(src.indexOf("await guard(\n        'web-server'"));
    expect(src.slice(step, step + 600)).toContain("['system loop', shared.dispose]");
  });

  // F06 follow-up (live smoke) — boot closed its web listener with a bare
  // `close()`, which waits on every open `/sse/system` stream: SIGTERM with a
  // tab open hung until SIGKILL.
  it('boot closes its web listener with closeListener, after closing chat', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toContain('() => closeListener(webServer),');
    expect(src).not.toContain('webServer.close(() => resolve())');
    const settle = src.indexOf("await guard('force-settle-approvals'");
    const chat = src.indexOf("await guard('close-chat', () => created.closeChat());");
    const web = src.indexOf("'web-server',");
    expect(settle).toBeGreaterThan(-1);
    expect(chat).toBeGreaterThan(settle);
    expect(web).toBeGreaterThan(chat);
  });

  it('boot closes its own five sessions.db handles and the observability store, last', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const step = src.indexOf("await guard('runtime-dispose'");
    const tail = src.slice(step, step + 1500);
    for (const handle of [
      'contextLog.close();',
      'session.close();',
      'apiKeys.close();',
      'idempotencyStore.close();',
      'metricsApiKeys.close();',
    ]) {
      expect(tail).toContain(handle);
    }
    expect(tail.indexOf("['system loop', shared.dispose]")).toBeLessThan(
      tail.indexOf("'sessions.db'"),
    );
    expect(tail).toContain("['observability.db', async () => closeObservabilityStore()]");
  });

  it('serve closes chat before its listener in both branches', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(
      src.match(
        /await created\.closeChat\(\);\n(?:\s*\/\/.*\n)*\s*(?:if \(webShutdown\) )?await webShutdown\(\);/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(src).not.toMatch(/server\.close\(\(\) => resolve\(\)\)/);
  });

  it('boot closes the a2a task store and the observe-mode transcript handle', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toContain("['a2a tasks.db', async () => a2a.taskStore.close()],");
    expect(src).toContain('channelTranscript.close();');
  });

  it('gateway closes the observe-mode transcript handle with its other stores', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain('channelTranscript.close();');
  });

  // Lifecycle audit G3 — `ethos gateway start` closed its loops but left the
  // process-wide observability store, its metrics api-key handle and the Slack
  // App Home session readers open, and re-ran the whole teardown on a second
  // signal.
  it('gateway closes the process-wide stores it opened, and shuts down once', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain('closeObservabilityStore()');
    expect(src).toContain('metricsApiKeys.close();');
    expect(src).toContain('closeSlackSessionStores();');
    // Memoised like serve's and boot's: a second signal awaits the first run.
    expect(src).toContain('shuttingDown ??= (async () => {');
  });

  it('boot closes the Slack App Home session handles too', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toContain('closeSlackSessionStores();');
  });

  it('boot hands every hot-add commit the prepared loop to release on failure', async () => {
    // `commitHotAdd` runs `release` whichever step throws — pinned in
    // apps/ethos/src/__tests__/config-reload-transactions.test.ts.
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src.match(/commitHotAdd\(\{/g) ?? []).toHaveLength(2);
    expect(src).toContain('release: () => releaseBotLoops(wiring, id),');
    expect(src).toContain('release: () => releaseBotLoops(prepared.wiring, ');
    // …and every live swap the prepared replacement to release if retiring
    // the old bot throws (`swapBotLive`'s `release`, config-reload.ts).
    expect(
      src.match(/release: \(prepared\) => releaseBotLoops\(prepared\.wiring, /g) ?? [],
    ).toHaveLength(2);
  });
});
