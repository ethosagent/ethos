// Process-level rejection/exception guards (plan openclaw-2026.9.6-gaps R2).
//
// Before this only `ethos serve` registered handlers; `ethos gateway start`
// and `ethos boot` — the two commands that own platform adapters — registered
// none, so one stray rejected promise (a `void`-ed cron fire, an MCP child, a
// plugin) killed every lane at once and systemd restarted it into the same
// state. Runtime half here; the source-text half (each command installs it) is
// `commands/__tests__/process-guards-wiring.test.ts`.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installProcessGuards } from '../process-guards';

function harness(withShutdown: boolean) {
  const proc = new EventEmitter();
  const on = vi.spyOn(proc, 'on');
  const errorLog = vi.fn();
  const recordSafetyBlock = vi.fn();
  const exit = vi.fn();
  const warn = vi.fn();
  let finishShutdown: () => void = () => {};
  const shutdown = vi.fn(
    (_code: number) =>
      new Promise<void>((resolve) => {
        finishShutdown = resolve;
      }),
  );
  installProcessGuards({
    command: 'gateway',
    observability: () => ({ recordSafetyBlock }),
    ...(withShutdown ? { shutdown } : {}),
    errorLog,
    exit,
    warn,
    proc,
  });
  return {
    proc,
    on,
    errorLog,
    recordSafetyBlock,
    exit,
    shutdown,
    warn,
    finish: () => finishShutdown(),
  };
}

describe('installProcessGuards', () => {
  it('installs an unhandledRejection and an uncaughtException listener', () => {
    const h = harness(true);
    expect(h.on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(h.on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
  });

  it('is idempotent per process — a second install adds no listeners', () => {
    const proc = new EventEmitter();
    const opts = {
      command: 'serve' as const,
      observability: () => ({ recordSafetyBlock: vi.fn() }),
      errorLog: vi.fn(),
      exit: vi.fn(),
      warn: vi.fn(),
      proc,
    };
    installProcessGuards(opts);
    installProcessGuards(opts);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    expect(proc.listenerCount('uncaughtException')).toBe(1);
  });

  it('a rejection writes one error-log entry and one event, and the process keeps running', () => {
    const h = harness(true);
    h.proc.emit('unhandledRejection', new Error('cron fire rejected'), Promise.resolve());
    expect(h.errorLog).toHaveBeenCalledTimes(1);
    expect(h.errorLog.mock.calls[0]?.[0]).toMatchObject({
      code: 'INTERNAL',
      cause: expect.stringContaining('cron fire rejected'),
    });
    expect(h.errorLog.mock.calls[0]?.[1]).toEqual({ command: 'gateway' });
    expect(h.recordSafetyBlock).toHaveBeenCalledTimes(1);
    expect(h.recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'process.unhandled_rejection',
        details: { command: 'gateway' },
      }),
    );
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it('an uncaught exception logs, records, runs the bounded shutdown with code 1, then exits 1', async () => {
    const h = harness(true);
    h.proc.emit('uncaughtException', new Error('boom'));
    expect(h.errorLog).toHaveBeenCalledTimes(1);
    expect(h.recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'process.uncaught_exception' }),
    );
    expect(h.shutdown).toHaveBeenCalledWith(1);
    // Not before the shutdown has had its chance.
    expect(h.exit).not.toHaveBeenCalled();

    // A second exception while shutting down does not start a second one.
    h.proc.emit('uncaughtException', new Error('again'));
    expect(h.shutdown).toHaveBeenCalledTimes(1);

    h.finish();
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(1));
  });

  it('with no shutdown wired (serve), an uncaught exception is logged and survived', () => {
    const h = harness(false);
    h.proc.emit('uncaughtException', new Error('stray SSE write'));
    expect(h.errorLog).toHaveBeenCalledTimes(1);
    expect(h.recordSafetyBlock).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('an observability sink that throws never escapes the guard', () => {
    const proc = new EventEmitter();
    const errorLog = vi.fn();
    installProcessGuards({
      command: 'boot',
      observability: () => {
        throw new Error('store closed');
      },
      errorLog,
      exit: vi.fn(),
      warn: vi.fn(),
      proc,
    });
    expect(() =>
      proc.emit('unhandledRejection', 'plain string reason', Promise.resolve()),
    ).not.toThrow();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
