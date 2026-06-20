import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecChunk, ExecOpts, ExecSession, ExecutionBackend, Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessTools } from '../index';
import { loadRegistry } from '../registry';

function makeCtx(workingDir: string) {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    personalityId: 'router',
  };
}

function getTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

/**
 * A backend whose session models a containerized process: exec streams an
 * initial line, then blocks forever until `stop()` is called, at which point
 * the stream ends (the in-container process was signalled). This is exactly the
 * lifecycle the real DockerPersistentSession exhibits — the host has no pid, so
 * stop/watch hit the session, and stream completion drives terminal state.
 */
function makeControllableBackend(opts?: { writeLine?: string }): {
  backend: ExecutionBackend;
  stopped: Array<'SIGTERM' | 'SIGKILL'>;
} {
  const stopped: Array<'SIGTERM' | 'SIGKILL'> = [];
  let release: () => void = () => {};
  const latch = new Promise<void>((r) => {
    release = r;
  });

  const session: ExecSession = {
    personalityId: 'router',
    exec(_cmd: string, _o: ExecOpts = {}): AsyncIterable<ExecChunk> {
      async function* g(): AsyncIterable<ExecChunk> {
        if (opts?.writeLine) yield { stream: 'stdout', data: opts.writeLine };
        await latch; // blocks until stop() releases it
      }
      return g();
    },
    stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
      stopped.push(signal);
      release(); // signalling the container ends the exec stream
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  };

  const backend: ExecutionBackend = {
    name: 'docker',
    isAvailable: () => Promise.resolve(true),
    exec: () => {
      async function* g(): AsyncIterable<ExecChunk> {}
      return g();
    },
    spawnSession: () => session,
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };

  return { backend, stopped };
}

async function startRouted(
  dataDir: string,
  backend: ExecutionBackend,
  command = 'sleep',
): Promise<{ id: string; pid: number }> {
  const tools = createProcessTools(dataDir, { backend, personality: undefined });
  const start = getTool(tools, 'process_start');
  const result = await start.execute({ command }, makeCtx('/tmp'));
  if (!result.ok) throw new Error('process_start failed');
  return JSON.parse(result.value) as { id: string; pid: number };
}

describe('process_stop against a containerized (backend-routed) process', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ethos-routed-lc-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('signals the in-container process via the session and marks it killed', async () => {
    const { backend, stopped } = makeControllableBackend();
    const { pid } = await startRouted(dataDir, backend);
    const id = Object.keys(loadRegistry(dataDir))[0] as string;

    // Routed processes have no host pid.
    expect(pid).toBe(-1);

    const tools = createProcessTools(dataDir, { backend, personality: undefined });
    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute({ id, signal: 'SIGTERM' }, makeCtx('/tmp'));

    expect(result.ok).toBe(true);
    // The signal reached the session (the container), not a host pid.
    expect(stopped).toContain('SIGTERM');
    // The entry is terminal (killed); the stream ended after the signal.
    const entry = loadRegistry(dataDir)[id];
    expect(entry?.status).toBe('killed');
  });

  it('fires process_complete after a routed process is stopped', async () => {
    const fired: unknown[] = [];
    const hookRegistry = {
      fireVoid: (_name: string, payload: unknown) => {
        fired.push(payload);
        return Promise.resolve();
      },
      registerVoid: () => () => {},
      fireModifying: async () => ({}),
      registerModifying: () => () => {},
      fireClaiming: async () => ({ handled: false }),
      registerClaiming: () => () => {},
    } as never;
    const { backend } = makeControllableBackend();
    const tools = createProcessTools(dataDir, { backend, hookRegistry, personality: undefined });
    const start = getTool(tools, 'process_start');
    const started = await start.execute({ command: 'sleep' }, makeCtx('/tmp'));
    expect(started.ok).toBe(true);
    const id = Object.keys(loadRegistry(dataDir))[0] as string;

    const stop = getTool(tools, 'process_stop');
    await stop.execute({ id, signal: 'SIGTERM' }, makeCtx('/tmp'));

    for (let i = 0; i < 50 && fired.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fired.length).toBeGreaterThan(0);
  });

  it('preserves the per-personality concurrency cap for routed processes', async () => {
    const { backend } = makeControllableBackend();
    const tools = createProcessTools(dataDir, { backend, capMax: 1, personality: undefined });
    const start = getTool(tools, 'process_start');
    const ctx = makeCtx('/tmp');

    const r1 = await start.execute({ command: 'sleep' }, ctx);
    expect(r1.ok).toBe(true);
    const r2 = await start.execute({ command: 'sleep' }, ctx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/PROCESS_CAP_EXCEEDED/);
  });
});

describe('process_watch against a containerized (backend-routed) process', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ethos-routed-watch-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tails containerized output and matches a pattern', async () => {
    const { backend } = makeControllableBackend({ writeLine: 'server listening on :8080\n' });
    const { id } = await startRouted(dataDir, backend, 'run-server');

    const tools = createProcessTools(dataDir, { backend, personality: undefined });
    const watch = getTool(tools, 'process_watch');

    // The drain loop writes the line to the log on a microtask; the watcher
    // tails the live log file and resolves on first match (no host pid needed —
    // liveness for routed processes is the registry status).
    const result = await watch.execute(
      { id, patterns: ['listening on'], timeout_s: 3, stop_on_first_match: true },
      makeCtx('/tmp'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.value) as { matched: boolean };
      expect(parsed.matched).toBe(true);
    }
  });
});
