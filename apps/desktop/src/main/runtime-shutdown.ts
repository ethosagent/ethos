/**
 * Everything one in-process desktop backend holds, and the ONE order it is
 * released in (F06, plan/phases/architecture-suggestions-2026-09-10.md). The
 * desktop stops and restarts its backend inside a single Electron main
 * process, so "stop" has to leave nothing of the old runtime behind: a
 * scheduler, executor or open store that survives it runs beside the next one.
 *
 * Every field is optional so the same function releases a backend whose start
 * failed half way — `startServer` fills the handles in as it creates them and
 * hands whatever exists here on a throw.
 *
 * Kept free of Electron imports so it can be tested directly:
 * apps/desktop/src/main/__tests__/runtime-shutdown.test.ts.
 */
export interface DesktopRuntime {
  /** Deny + audit every suspended approval (`CreateWebApiResult.forceSettleApprovals`). */
  settleApprovals?: () => void;
  /** `CreateWebApiResult.closeChat` — aborts the web turns and writes the
   *  "not sent" notice to each tab's SSE stream, so it runs before the server
   *  close drops those streams. */
  closeChat?: () => Promise<void>;
  callCapture?: { stop(): Promise<void> };
  /** WS lanes on the HTTP server (talk-mode, satellites, takeover). They hold
   *  connections open by design, so they close before the server does. */
  sockets?: Array<{ close(): Promise<void> }>;
  /** The HTTP server. Closed with every connection still open dropped — a
   *  plain `close()` waits on the `/sse/system` stream each window holds. */
  server?: { close(cb?: () => void): unknown; closeAllConnections?(): void };
  /** `CreateWebApiResult.dispose` — the surface that borrowed the loop. */
  webApi?: { dispose(): Promise<void> };
  /** `CreateAgentLoopResult.dispose` — the loop's own runtime. */
  loop?: { dispose(): Promise<void> };
  /** The desktop's own sessions.db handle, lent to the web API. */
  sessionStore?: { close(): void };
}

/** The same bound `ethos serve` puts on its disposal before exit
 *  (`DISPOSE_BEFORE_EXIT_GRACE_MS`, apps/ethos/src/lib/dispose-before-exit.ts). */
export const DESKTOP_SHUTDOWN_GRACE_MS = 10_000;

/**
 * Release a runtime: stop accepting work (approvals settled, chat closed, call
 * capture, sockets, HTTP), then the web API, then the loop, then the store the desktop
 * itself opened. Every step is attempted even when one throws; failures
 * reject together as one `AggregateError`.
 *
 * Bounded: all steps share one `graceMs` budget, and a step still pending when
 * it runs out is reported as a failure and left behind, so a dispose that
 * never settles (a hung executor drain, a plugin's `deactivate`) cannot hold
 * the desktop's stop or restart open forever.
 */
export async function shutdownDesktopRuntime(
  runtime: DesktopRuntime,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? DESKTOP_SHUTDOWN_GRACE_MS;
  const deadline = Date.now() + graceMs;
  const steps: ReadonlyArray<readonly [label: string, run: () => unknown]> = [
    // FIRST, and synchronous: the auto-deny timers are unref'd and never fire
    // on the way out, and a later await that hangs must not cost the audit row.
    ['approvals', () => runtime.settleApprovals?.()],
    ['chat', () => runtime.closeChat?.()],
    ['call capture', () => runtime.callCapture?.stop()],
    ...(runtime.sockets ?? []).map((socket) => ['socket', () => socket.close()] as const),
    ['http server', () => closeServer(runtime.server)],
    ['web api', () => runtime.webApi?.dispose()],
    ['agent loop', () => runtime.loop?.dispose()],
    ['session store', () => runtime.sessionStore?.close()],
  ];
  const failures: Error[] = [];
  for (const [label, run] of steps) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outOfTime = new Promise<'timeout'>((resolve) => {
        // Referenced on purpose: a hung step holding no handle of its own must
        // not let the event loop drain mid-shutdown.
        timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      });
      const outcome = await Promise.race([Promise.resolve(run()), outOfTime]);
      if (outcome === 'timeout') {
        failures.push(new Error(`${label}: did not finish within ${graceMs}ms`));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failures.push(new Error(`${label}: ${detail}`, { cause: err }));
    } finally {
      clearTimeout(timer);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `desktop backend shutdown: ${failures.map((f) => f.message).join('; ')}`,
    );
  }
}

/** Same pause `closeListener` (apps/ethos/src/commands/serve-listen.ts) gives
 *  writes already queued on open streams before their sockets drop. */
const SERVER_FLUSH_MS = 100;

async function closeServer(server: DesktopRuntime['server']): Promise<void> {
  if (!server) return;
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await new Promise<void>((resolve) => setTimeout(resolve, SERVER_FLUSH_MS));
  server.closeAllConnections?.();
  await closed;
}
