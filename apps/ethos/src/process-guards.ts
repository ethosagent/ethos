// Process-level `unhandledRejection` / `uncaughtException` guards for the
// long-running commands — plan openclaw-2026.9.6-gaps R2. The ONE place they
// are registered: `ethos gateway start` and `ethos boot` pass their bounded
// shutdown, `ethos serve` passes none.
//
// Node 24 exits on an unhandled rejection by default. In a process that owns
// platform adapters that is every lane at once, for one `void`-ed promise
// anywhere — a cron trigger's `void engine.fire()`, an MCP child, a plugin.
// A rejection is therefore logged (`~/.ethos/logs/errors.jsonl`, via
// `appendErrorLog`), recorded as a `process.unhandled_rejection` event, and
// survived.
//
// An uncaught EXCEPTION is different: the stack it unwound may have left any
// state half-written, so a command with a shutdown runs it (the same bounded
// teardown SIGTERM runs — replies drained, stores closed, the gateway lock
// released) and exits 1, which systemd restarts. Without a shutdown (serve,
// whose guard predates this module and kept the server alive on both) it is
// logged and survived, as before.

import { EthosError } from '@ethosagent/types';
import { appendErrorLog } from './error-log';

/** The one event sink this needs — `EthosObservability.recordSafetyBlock`. */
interface SafetyBlockSink {
  recordSafetyBlock(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

/** Minimal `process` surface, injectable so tests do not touch the real one. */
interface ListenerHost {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (err: unknown) => void): unknown;
}

export interface ProcessGuardsOptions {
  /** Stamped on the error-log line and the event's details. */
  command: 'gateway' | 'boot' | 'serve';
  /** Resolved per event (the observability store can be closed and reopened
   *  under a running process); a throwing sink is swallowed. */
  observability: () => SafetyBlockSink;
  /** The command's bounded shutdown. Called once with exit code 1 on an
   *  uncaught exception. Absent → the exception is logged and survived. */
  shutdown?: (exitCode: number) => Promise<void>;
  errorLog?: typeof appendErrorLog;
  exit?: (code: number) => void;
  warn?: (message: string) => void;
  proc?: ListenerHost;
}

/** An uncaught exception's shutdown gets this long before `exit(1)` anyway. The
 *  shutdowns it calls are bounded step by step; this covers one that is not,
 *  because the exception may have broken whatever it was waiting on. */
const UNCAUGHT_SHUTDOWN_BACKSTOP_MS = 60_000;

const installedOn = new WeakSet<object>();

export function installProcessGuards(opts: ProcessGuardsOptions): void {
  const proc = opts.proc ?? process;
  if (installedOn.has(proc)) return;
  installedOn.add(proc);
  const errorLog = opts.errorLog ?? appendErrorLog;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const warn = opts.warn ?? ((message: string) => console.error(message));
  const { command } = opts;

  const report = (kind: 'rejection' | 'exception', err: unknown, action: string): string => {
    const cause = err instanceof Error ? err.message : String(err);
    const label = kind === 'rejection' ? 'Unhandled promise rejection' : 'Uncaught exception';
    errorLog(new EthosError({ code: 'INTERNAL', cause: `${label}: ${cause}`, action }), {
      command,
    });
    try {
      opts.observability().recordSafetyBlock({
        code: kind === 'rejection' ? 'process.unhandled_rejection' : 'process.uncaught_exception',
        cause,
        details: { command },
      });
    } catch {
      // Fail-open: observability must never turn a survived error into a crash.
    }
    return cause;
  };

  proc.on('unhandledRejection', (reason) => {
    const cause = report(
      'rejection',
      reason,
      'A background promise rejected and was not awaited. The process kept running.',
    );
    warn(`[${command}] unhandled rejection (kept alive): ${cause}`);
  });

  let exiting = false;
  proc.on('uncaughtException', (err) => {
    const { shutdown } = opts;
    if (!shutdown) {
      const cause = report(
        'exception',
        err,
        'An uncaught exception was trapped. The process kept running.',
      );
      warn(`[${command}] uncaught exception (kept alive): ${cause}`);
      return;
    }
    const cause = report(
      'exception',
      err,
      'An uncaught exception was trapped. The process shut down and exited 1 for its supervisor to restart.',
    );
    if (exiting) return;
    exiting = true;
    warn(`[${command}] uncaught exception, shutting down: ${cause}`);
    const backstop = setTimeout(() => exit(1), UNCAUGHT_SHUTDOWN_BACKSTOP_MS);
    let stopping: Promise<void>;
    try {
      stopping = shutdown(1);
    } catch (e) {
      stopping = Promise.reject(e);
    }
    void stopping
      .catch(() => {})
      .finally(() => {
        clearTimeout(backstop);
        exit(1);
      });
  });
}
