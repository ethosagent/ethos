import type { TeamRuntime } from '@ethosagent/team-supervisor';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureSupervisorRunning,
  type SupervisorLifecycleDeps,
  stopSupervisor,
} from '../supervisor-lifecycle';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ENTRY = '/repo/apps/ethos/src/index.ts';

function makeRuntime(pid: number): TeamRuntime {
  return {
    name: 'eng',
    manifestPath: '/home/.ethos/teams/eng.yaml',
    supervisorPid: pid,
    startedAt: new Date().toISOString(),
    members: [],
  };
}

// The minimal fake ChildProcess-like shape our spawn deps return.
function fakeChild(pid = 1234) {
  return { pid, unref: vi.fn() };
}

// ---------------------------------------------------------------------------
// ensureSupervisorRunning
// ---------------------------------------------------------------------------

describe('ensureSupervisorRunning', () => {
  it('returns already-running and does not spawn when supervisor PID is alive', async () => {
    const spawn = vi.fn();
    const deps: SupervisorLifecycleDeps = {
      readRuntime: () => makeRuntime(99),
      isPidAlive: () => true,
      removeRuntime: vi.fn(),
      spawn,
      waitMs: 0,
    };

    const result = await ensureSupervisorRunning('eng', ENTRY, deps);

    expect(result.status).toBe('already-running');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns supervisor when runtime is missing', async () => {
    const child = fakeChild(200);
    const spawn = vi.fn().mockReturnValue(child);
    const readRuntime = vi.fn().mockReturnValue(null);
    const deps: SupervisorLifecycleDeps = {
      readRuntime,
      isPidAlive: () => false,
      removeRuntime: vi.fn(),
      spawn,
      waitMs: 0,
    };

    const result = await ensureSupervisorRunning('eng', ENTRY, deps);

    expect(result.status).toBe('spawned');
    expect(spawn).toHaveBeenCalledOnce();
    // Args include team name and tsx loader (TypeScript entry)
    const [, args] = spawn.mock.calls[0] as [unknown, string[], unknown];
    expect(args).toContain('_supervisor');
    expect(args).toContain('eng');
    expect(child.unref).toHaveBeenCalled();
  });

  it('removes stale runtime and respawns when PID is no longer alive', async () => {
    const child = fakeChild(300);
    const spawn = vi.fn().mockReturnValue(child);
    const removeRuntime = vi.fn();
    const deps: SupervisorLifecycleDeps = {
      readRuntime: () => makeRuntime(42),
      isPidAlive: () => false, // stale
      removeRuntime,
      spawn,
      waitMs: 0,
    };

    const result = await ensureSupervisorRunning('eng', ENTRY, deps);

    expect(result.status).toBe('spawned');
    expect(removeRuntime).toHaveBeenCalledWith('eng');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('returns confirmed PID from runtime file when supervisor starts successfully', async () => {
    const child = fakeChild(200);
    const spawn = vi.fn().mockReturnValue(child);
    // First call (pre-spawn check): null. Second call (post-spawn verify): live runtime.
    const readRuntime = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(makeRuntime(200));
    const deps: SupervisorLifecycleDeps = {
      readRuntime,
      isPidAlive: () => true,
      removeRuntime: vi.fn(),
      spawn,
      waitMs: 0,
    };

    const result = await ensureSupervisorRunning('eng', ENTRY, deps);

    expect(result.status).toBe('spawned');
    expect(result.pid).toBe(200);
  });

  it('returns pid undefined when supervisor does not publish runtime after spawn', async () => {
    const child = fakeChild(200);
    const spawn = vi.fn().mockReturnValue(child);
    const deps: SupervisorLifecycleDeps = {
      readRuntime: vi.fn().mockReturnValue(null), // never writes runtime
      isPidAlive: () => false,
      removeRuntime: vi.fn(),
      spawn,
      waitMs: 0,
    };

    const result = await ensureSupervisorRunning('eng', ENTRY, deps);

    expect(result.status).toBe('spawned');
    expect(result.pid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stopSupervisor
// ---------------------------------------------------------------------------

describe('stopSupervisor', () => {
  it('sends SIGTERM when supervisor PID is alive', () => {
    const kill = vi.fn();
    const deps = {
      readRuntime: () => makeRuntime(99),
      isPidAlive: () => true,
      kill,
    };

    stopSupervisor('eng', deps);

    expect(kill).toHaveBeenCalledWith(99, 'SIGTERM');
  });

  it('does nothing when runtime is missing', () => {
    const kill = vi.fn();
    const deps = {
      readRuntime: () => null,
      isPidAlive: () => false,
      kill,
    };

    stopSupervisor('eng', deps);

    expect(kill).not.toHaveBeenCalled();
  });

  it('does nothing when supervisor PID is no longer alive', () => {
    const kill = vi.fn();
    const deps = {
      readRuntime: () => makeRuntime(999),
      isPidAlive: () => false,
      kill,
    };

    stopSupervisor('eng', deps);

    expect(kill).not.toHaveBeenCalled();
  });
});
