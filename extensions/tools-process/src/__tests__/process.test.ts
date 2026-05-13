import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessTools } from '../index';
import { loadRegistry, saveRegistry } from '../registry';
import { LOG_MAX_BYTES } from '../spawn';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  };
}

function getTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let workDir: string;
let tools: Tool[];

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-proc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workDir = dataDir;
  mkdirSync(dataDir, { recursive: true });
  tools = createProcessTools(dataDir);
});

afterEach(() => {
  // best-effort cleanup: kill any running processes from the test
  const registry = loadRegistry(dataDir);
  for (const entry of Object.values(registry)) {
    if (entry.status === 'running') {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// process_start
// ---------------------------------------------------------------------------

describe('process_start', () => {
  it('returns id, pid, name, started_at and the process is running', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as {
      id: string;
      pid: number;
      name: string;
      started_at: string;
    };
    expect(data.id).toBeTruthy();
    expect(data.pid).toBeGreaterThan(0);
    expect(data.name).toBeTruthy();
    expect(data.started_at).toBeTruthy();

    // The process should actually be alive
    expect(() => process.kill(data.pid, 0)).not.toThrow();

    // cleanup
    process.kill(data.pid, 'SIGKILL');
  });

  it('uses ctx.workingDir as default cwd', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id } = JSON.parse(result.value) as { id: string; pid: number };
    const entry = loadRegistry(dataDir)[id];
    expect(entry?.cwd).toBe(workDir);

    process.kill(entry?.pid ?? 0, 'SIGKILL');
  });

  it('uses a custom name when provided', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute(
      { command: 'sleep 30', name: 'my-server' },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { name: string; pid: number };
    expect(data.name).toBe('my-server');
    process.kill(data.pid, 'SIGKILL');
  });

  it('records started_by from ctx.personalityId', async () => {
    const start = getTool(tools, 'process_start');
    const ctx = { ...makeCtx(workDir), personalityId: 'archivist' };
    const result = await start.execute({ command: 'sleep 30' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id, pid } = JSON.parse(result.value) as { id: string; pid: number };
    expect(loadRegistry(dataDir)[id]?.started_by).toBe('archivist');
    process.kill(pid, 'SIGKILL');
  });

  it("records started_by as 'unknown' when ctx has no personalityId", async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id, pid } = JSON.parse(result.value) as { id: string; pid: number };
    expect(loadRegistry(dataDir)[id]?.started_by).toBe('unknown');
    process.kill(pid, 'SIGKILL');
  });

  it('returns input_invalid when command is missing', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('enforces cap of 8 concurrent processes', async () => {
    // Inject 8 running entries directly into the registry without actually spawning
    const registry = loadRegistry(dataDir);
    for (let i = 0; i < 8; i++) {
      const id = `fake-${i}`;
      registry[id] = {
        id,
        name: `fake-${i}`,
        pid: 99999 + i,
        command: 'sleep 999',
        cwd: workDir,
        status: 'running',
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        started_by: 'test',
      };
    }
    saveRegistry(dataDir, registry);

    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'echo hi' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('PROCESS_CAP_EXCEEDED');
    }
  });
});

// ---------------------------------------------------------------------------
// process_list
// ---------------------------------------------------------------------------

describe('process_list', () => {
  it('shows a running process', async () => {
    const start = getTool(tools, 'process_start');
    const list = getTool(tools, 'process_list');

    const startResult = await start.execute(
      { command: 'sleep 30', name: 'sleeper' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const listResult = await list.execute({}, makeCtx(workDir));
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const items = JSON.parse(listResult.value) as Array<{ id: string; status: string }>;
    const found = items.find((x) => x.id === id);
    expect(found).toBeDefined();
    expect(found?.status).toBe('running');

    process.kill(pid, 'SIGKILL');
  });

  it('marks orphan when process is killed externally', async () => {
    const start = getTool(tools, 'process_start');
    const list = getTool(tools, 'process_list');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Kill externally without going through process_stop
    process.kill(pid, 'SIGKILL');

    // Give the OS a moment to reap the process
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    const listResult = await list.execute({}, makeCtx(workDir));
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const items = JSON.parse(listResult.value) as Array<{ id: string; status: string }>;
    const found = items.find((x) => x.id === id);
    expect(found?.status).toBe('orphan');
  });

  it('returns an empty array when no processes tracked', async () => {
    const list = getTool(tools, 'process_list');
    const result = await list.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toEqual([]);
  });

  it('does NOT rotate the log of a running process (live fd must not be renamed)', async () => {
    // A running detached child holds an open fd to its log inode. process_list
    // must leave that log alone even when it is oversized.
    const start = getTool(tools, 'process_start');
    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Inflate its stdout log past the threshold while it is still running.
    const stdoutLog = join(dataDir, 'processes', id, 'stdout.log');
    writeFileSync(stdoutLog, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');

    await getTool(tools, 'process_list').execute({}, makeCtx(workDir));

    expect(existsSync(`${stdoutLog}.1`)).toBe(false);
    expect(statSync(stdoutLog).size).toBe(LOG_MAX_BYTES + 1);

    process.kill(pid, 'SIGKILL');
  });

  it('rotates the oversized log of a terminal process', async () => {
    const id = 'exited-big-log';
    const procDir = join(dataDir, 'processes', id);
    mkdirSync(procDir, { recursive: true });
    const stdoutLog = join(procDir, 'stdout.log');
    writeFileSync(stdoutLog, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');
    saveRegistry(dataDir, {
      [id]: {
        id,
        name: id,
        pid: 999999,
        command: 'echo done',
        cwd: workDir,
        status: 'exited',
        exitCode: 0,
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        started_by: 'test',
      },
    });

    await getTool(tools, 'process_list').execute({}, makeCtx(workDir));

    expect(existsSync(`${stdoutLog}.1`)).toBe(true);
    expect(statSync(stdoutLog).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// process_logs
// ---------------------------------------------------------------------------

describe('process_logs', () => {
  it('returns last N lines from stdout', async () => {
    const start = getTool(tools, 'process_start');
    const logs = getTool(tools, 'process_logs');

    // Write 5 lines then sleep so the process stays alive long enough
    const startResult = await start.execute(
      { command: 'for i in 1 2 3 4 5; do echo "line$i"; done; sleep 30' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Wait for lines to be written
    await waitFor(() => {
      const logPath = join(dataDir, 'processes', id, 'stdout.log');
      try {
        if (!existsSync(logPath)) return false;
        return readFileSync(logPath, 'utf8').includes('line5');
      } catch {
        return false;
      }
    });

    const logsResult = await logs.execute({ id, lines: 3, stream: 'stdout' }, makeCtx(workDir));
    expect(logsResult.ok).toBe(true);
    if (!logsResult.ok) return;
    const output = logsResult.value;
    expect(output).toContain('line3');
    expect(output).toContain('line4');
    expect(output).toContain('line5');
    expect(output).not.toContain('line1');
    expect(output).not.toContain('line2');

    process.kill(pid, 'SIGKILL');
  });

  it('returns (no output) for a process with empty logs', async () => {
    const start = getTool(tools, 'process_start');
    const logs = getTool(tools, 'process_logs');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Don't wait — logs should be empty immediately after start
    const logsResult = await logs.execute({ id, stream: 'stdout' }, makeCtx(workDir));
    expect(logsResult.ok).toBe(true);
    if (!logsResult.ok) return;
    expect(logsResult.value).toBe('(no output)');

    process.kill(pid, 'SIGKILL');
  });

  it('returns execution_failed for unknown id', async () => {
    const logs = getTool(tools, 'process_logs');
    const result = await logs.execute({ id: 'does-not-exist' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid when id is missing', async () => {
    const logs = getTool(tools, 'process_logs');
    const result = await logs.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

// ---------------------------------------------------------------------------
// process_stop
// ---------------------------------------------------------------------------

describe('process_stop', () => {
  it('stops a running process with SIGTERM', async () => {
    const start = getTool(tools, 'process_start');
    const stop = getTool(tools, 'process_stop');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const stopResult = await stop.execute({ id }, makeCtx(workDir));
    expect(stopResult.ok).toBe(true);
    if (!stopResult.ok) return;
    const data = JSON.parse(stopResult.value) as { stopped: boolean };
    expect(data.stopped).toBe(true);

    // Registry entry should be 'killed'
    const entry = loadRegistry(dataDir)[id];
    expect(entry?.status).toBe('killed');

    // Verify process is actually gone (give OS a moment)
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('stops a running process with SIGKILL', async () => {
    const start = getTool(tools, 'process_start');
    const stop = getTool(tools, 'process_stop');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const stopResult = await stop.execute({ id, signal: 'SIGKILL' }, makeCtx(workDir));
    expect(stopResult.ok).toBe(true);
    if (!stopResult.ok) return;
    const data = JSON.parse(stopResult.value) as { stopped: boolean };
    expect(data.stopped).toBe(true);

    process.kill(pid, 'SIGKILL'); // no-op if already dead
  });

  it('returns stopped:false for an already-exited process', async () => {
    const stop = getTool(tools, 'process_stop');
    const registry = loadRegistry(dataDir);
    const id = 'already-done';
    registry[id] = {
      id,
      name: 'done',
      pid: 12345,
      command: 'echo hi',
      cwd: workDir,
      status: 'exited',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      lastTouchedAt: new Date().toISOString(),
      started_by: 'test',
    };
    saveRegistry(dataDir, registry);

    const result = await stop.execute({ id }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { stopped: boolean; exit_code?: number };
    expect(data.stopped).toBe(false);
    expect(data.exit_code).toBe(0);
  });

  it('returns execution_failed for unknown id', async () => {
    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute({ id: 'does-not-exist' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid when id is missing', async () => {
    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

// ---------------------------------------------------------------------------
// process_wait
// ---------------------------------------------------------------------------

describe('process_wait', () => {
  it('waits for a short-lived process to exit', async () => {
    const start = getTool(tools, 'process_start');
    const wait = getTool(tools, 'process_wait');

    const startResult = await start.execute({ command: 'sleep 0.1' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const waitResult = await wait.execute({ id, timeout_s: 5 }, makeCtx(workDir));
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) return;
    const data = JSON.parse(waitResult.value) as { exited: boolean };
    expect(data.exited).toBe(true);
  });

  it('returns exited:false when process does not finish in time', async () => {
    const start = getTool(tools, 'process_start');
    const wait = getTool(tools, 'process_wait');

    const startResult = await start.execute({ command: 'sleep 60' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const waitResult = await wait.execute({ id, timeout_s: 0.3 }, makeCtx(workDir));
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) {
      process.kill(pid, 'SIGKILL');
      return;
    }
    const data = JSON.parse(waitResult.value) as { exited: boolean };
    expect(data.exited).toBe(false);

    process.kill(pid, 'SIGKILL');
  });

  it('returns immediately for an already-exited process', async () => {
    const wait = getTool(tools, 'process_wait');
    const registry = loadRegistry(dataDir);
    const id = 'already-done-2';
    registry[id] = {
      id,
      name: 'done',
      pid: 12345,
      command: 'echo hi',
      cwd: workDir,
      status: 'exited',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      lastTouchedAt: new Date().toISOString(),
      started_by: 'test',
    };
    saveRegistry(dataDir, registry);

    const result = await wait.execute({ id }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { exited: boolean; exit_code?: number };
    expect(data.exited).toBe(true);
    expect(data.exit_code).toBe(0);
  });

  it('returns execution_failed for unknown id', async () => {
    const wait = getTool(tools, 'process_wait');
    const result = await wait.execute({ id: 'does-not-exist' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid when id is missing', async () => {
    const wait = getTool(tools, 'process_wait');
    const result = await wait.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createProcessTools', () => {
  it('returns 5 tools', () => {
    expect(tools).toHaveLength(5);
  });

  it('returns tools with distinct names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(5);
    expect(names).toContain('process_start');
    expect(names).toContain('process_list');
    expect(names).toContain('process_logs');
    expect(names).toContain('process_stop');
    expect(names).toContain('process_wait');
  });
});
