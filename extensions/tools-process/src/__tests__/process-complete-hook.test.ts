import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookRegistry, Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessTools } from '../index';
import { loadRegistry } from '../registry';

// Gap 10 — process_complete must fire on the REAL child exit (the
// `child.on('exit')` handler inside spawnDetached), exactly once, and a
// later process_wait on the same process must not re-fire it.

function makeCtx(workingDir: string) {
  return {
    sessionId: 'sess-1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function getTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

let dataDir: string;
let fireVoid: ReturnType<typeof vi.fn>;
let tools: Tool[];

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-proc-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
  fireVoid = vi.fn().mockResolvedValue(undefined);
  const hookRegistry = { fireVoid } as unknown as HookRegistry;
  tools = createProcessTools(dataDir, { hookRegistry });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('process_complete hook on child exit (Gap 10)', () => {
  it('fires once when the background process exits — without any process_wait', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'echo done-now' }, makeCtx(dataDir));
    expect(result.ok).toBe(true);

    await waitFor(() => fireVoid.mock.calls.length > 0);

    expect(fireVoid).toHaveBeenCalledTimes(1);
    const [hookName, payload] = fireVoid.mock.calls[0] as [string, Record<string, unknown>];
    expect(hookName).toBe('process_complete');
    expect(payload).toMatchObject({
      sessionId: 'sess-1',
      sessionKey: 'cli:test',
      exitCode: 0,
    });
    expect(typeof payload.processId).toBe('string');
    expect(typeof payload.durationMs).toBe('number');
    expect(typeof payload.stdout).toBe('string');
    expect(typeof payload.stderr).toBe('string');
  });

  it('a process_wait after the exit-handler fire does not re-fire the hook', async () => {
    const start = getTool(tools, 'process_start');
    const wait = getTool(tools, 'process_wait');
    const startResult = await start.execute({ command: 'echo hi' }, makeCtx(dataDir));
    expect(startResult.ok).toBe(true);
    const { id } = JSON.parse((startResult as { ok: true; value: string }).value) as {
      id: string;
    };

    // Wait until both the exit handler fired AND the registry shows terminal
    // state (so process_wait takes its "already exited" path).
    await waitFor(
      () => fireVoid.mock.calls.length > 0 && loadRegistry(dataDir)[id]?.status !== 'running',
    );
    expect(fireVoid).toHaveBeenCalledTimes(1);

    const waitResult = await wait.execute({ id }, makeCtx(dataDir));
    expect(waitResult.ok).toBe(true);

    // Once-guard: still exactly one fire.
    expect(fireVoid).toHaveBeenCalledTimes(1);

    // And a second process_wait doesn't re-fire either.
    await wait.execute({ id }, makeCtx(dataDir));
    expect(fireVoid).toHaveBeenCalledTimes(1);
  });

  it('reports a non-zero exit code', async () => {
    const start = getTool(tools, 'process_start');
    await start.execute({ command: 'exit 3' }, makeCtx(dataDir));

    await waitFor(() => fireVoid.mock.calls.length > 0);

    const [, payload] = fireVoid.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.exitCode).toBe(3);
  });
});
