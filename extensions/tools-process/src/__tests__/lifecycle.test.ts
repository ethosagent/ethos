import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRegistry } from '../operations';
import { loadRegistry, type ProcessEntry, saveRegistry } from '../registry';
import { spawnDetached } from '../spawn';

// Crash-recovery acceptance: after `ethos chat` crashes mid-session, the next
// `ethos` startup runs `reconcileRegistry`. Any entry still marked `running`
// whose pid no longer exists is flipped to `orphan` — so `process_list` never
// shows a confusing "is it still running?" state and the record is never lost.

let dataDir: string;

function entry(overrides: Partial<ProcessEntry> & { id: string }): ProcessEntry {
  const now = new Date().toISOString();
  return {
    name: overrides.id,
    pid: 999_999,
    command: 'sleep 999',
    cwd: dataDir,
    status: 'running',
    startedAt: now,
    lastTouchedAt: now,
    started_by: 'test',
    ...overrides,
  };
}

async function waitForDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

beforeEach(() => {
  dataDir = join(
    tmpdir(),
    `ethos-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  const registry = loadRegistry(dataDir);
  for (const e of Object.values(registry)) {
    // Never kill process.pid — some tests use the test runner's own pid as a
    // known-alive process; SIGKILL there would take down the vitest worker.
    if (e.status === 'running' && e.pid !== process.pid) {
      try {
        process.kill(e.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reconcileRegistry', () => {
  it('flips a running entry with a dead pid to orphan and bumps lastTouchedAt', async () => {
    const stale = '2020-01-01T00:00:00.000Z';
    saveRegistry(dataDir, {
      dead: entry({ id: 'dead', pid: 999_999, status: 'running', lastTouchedAt: stale }),
    });

    await reconcileRegistry(dataDir);

    const after = loadRegistry(dataDir).dead;
    expect(after?.status).toBe('orphan');
    expect(after?.lastTouchedAt).not.toBe(stale);
    expect(new Date(after?.lastTouchedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(stale).getTime(),
    );
  });

  it('leaves a running entry with a live pid as running', async () => {
    // process.pid is this test runner — guaranteed alive for the duration.
    saveRegistry(dataDir, {
      alive: entry({ id: 'alive', pid: process.pid, status: 'running' }),
    });

    await reconcileRegistry(dataDir);

    expect(loadRegistry(dataDir).alive?.status).toBe('running');
  });

  it('does not touch entries already in a terminal state', async () => {
    const stale = '2021-01-01T00:00:00.000Z';
    saveRegistry(dataDir, {
      exited: entry({ id: 'exited', pid: 999_999, status: 'exited', lastTouchedAt: stale }),
      killed: entry({ id: 'killed', pid: 999_998, status: 'killed', lastTouchedAt: stale }),
      orphan: entry({ id: 'orphan', pid: 999_997, status: 'orphan', lastTouchedAt: stale }),
    });

    await reconcileRegistry(dataDir);

    const after = loadRegistry(dataDir);
    expect(after.exited?.status).toBe('exited');
    expect(after.exited?.lastTouchedAt).toBe(stale);
    expect(after.killed?.status).toBe('killed');
    expect(after.killed?.lastTouchedAt).toBe(stale);
    expect(after.orphan?.status).toBe('orphan');
    expect(after.orphan?.lastTouchedAt).toBe(stale);
  });

  it('is a no-op and does not throw on a missing registry', async () => {
    const emptyDir = join(
      tmpdir(),
      `ethos-lifecycle-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(emptyDir, { recursive: true });
    try {
      await expect(reconcileRegistry(emptyDir)).resolves.toBeUndefined();
      expect(loadRegistry(emptyDir)).toEqual({});
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('crash-then-restart: a process that died during the crash becomes orphan, a survivor stays running', async () => {
    // Two real detached children: one we kill (simulating it dying while
    // `ethos chat` was crashed), one we leave alive (it outlived the crash).
    const dead = spawnDetached('crashed', 'sleep 30', dataDir, undefined, dataDir);
    const alive = spawnDetached('survivor', 'sleep 30', dataDir, undefined, dataDir);

    const now = new Date().toISOString();
    saveRegistry(dataDir, {
      crashed: entry({ id: 'crashed', pid: dead.pid, status: 'running', lastTouchedAt: now }),
      survivor: entry({ id: 'survivor', pid: alive.pid, status: 'running', lastTouchedAt: now }),
    });

    // The crash: the child dies while nothing is tracking it.
    process.kill(dead.pid, 'SIGKILL');
    await waitForDead(dead.pid);

    // The restart: `ethos` boots and reconciles.
    await reconcileRegistry(dataDir);

    const after = loadRegistry(dataDir);
    // Never lost — still in the registry.
    expect(after.crashed).toBeDefined();
    expect(after.crashed?.status).toBe('orphan');
    expect(after.survivor?.status).toBe('running');
    // The survivor is left for afterEach to SIGKILL — it still has a `running`
    // entry in the registry, so cleanup handles it.
  });
});
