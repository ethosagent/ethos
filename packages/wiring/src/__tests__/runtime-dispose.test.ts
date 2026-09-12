// F06 (plan/phases/architecture-suggestions-2026-09-10.md) — `createAgentLoop`
// OWNS what it starts, so it must be able to take all of it down again. Before
// this, it started the background executor (three intervals), the mesh proxy
// reconciler (one interval), opened jobs.db / goals.db / sessions.db and
// connected MCP + plugins, then handed back separate handles with no aggregate
// release — a host that stopped and rebuilt a runtime in one process (desktop
// restart, snapshot+terminate+load) kept runtime A's workers ticking beside B's.
//
// These drive the REAL composition root against a throwaway `~/.ethos` (HOME
// and ETHOS_STATE_DIR point at a temp dir, so the operator's installed plugins
// and MCP config are never read). Only `setInterval` is faked: it is what
// every long-lived worker here uses, and counting pending fake intervals is a
// direct measure of "what is still scheduled to tick".

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRunner } from '@ethosagent/goal-runner';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { BackgroundExecutor } from '@ethosagent/job-runner';
import { SQLiteJobStore } from '@ethosagent/job-store';
import { MemoryCaptureRunner } from '@ethosagent/memory-capture';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import { PluginLoader } from '@ethosagent/plugin-loader';
import { SQLiteContextLog, SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { MeshProxyReconciler } from '@ethosagent/tools-delegation';
import { McpManager } from '@ethosagent/tools-mcp';
import type { MemoryProvider } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-runtime-dispose-'));
  dataDir = join(home, '.ethos');
  mkdirSync(dataDir, { recursive: true });
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const CONFIG: WiringConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-test',
};

function build(config: WiringConfig = CONFIG) {
  return createAgentLoop(config, {
    dataDir,
    workingDir: home,
    profile: 'web',
    disableDocker: true,
  });
}

function spyOwners() {
  return {
    executorShutdown: vi.spyOn(BackgroundExecutor.prototype, 'shutdown'),
    reconcilerStop: vi.spyOn(MeshProxyReconciler.prototype, 'stop'),
    jobStoreClose: vi.spyOn(SQLiteJobStore.prototype, 'close'),
    goalStoreClose: vi.spyOn(SQLiteGoalStore.prototype, 'close'),
    sessionStoreClose: vi.spyOn(SQLiteSessionStore.prototype, 'close'),
    contextLogClose: vi.spyOn(SQLiteContextLog.prototype, 'close'),
    pluginsUnload: vi.spyOn(PluginLoader.prototype, 'unloadAll'),
    mcpShutdown: vi.spyOn(McpManager.prototype, 'shutdown'),
  };
}

describe('createAgentLoop owns its runtime (F06)', () => {
  it('dispose() stops the workers, clears their timers and closes the stores it opened', async () => {
    const spies = spyOwners();
    const result = await build();

    // The background subsystem is on for a long-lived profile, and it ticks.
    expect(result.backgroundExecutor).toBeDefined();
    expect(result.meshProxyReconciler).toBeDefined();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await result.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(spies.executorShutdown).toHaveBeenCalledTimes(1);
    expect(spies.reconcilerStop).toHaveBeenCalledTimes(1);
    expect(spies.jobStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.goalStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.sessionStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.contextLogClose).toHaveBeenCalledTimes(1);
    expect(spies.pluginsUnload).toHaveBeenCalledTimes(1);
    expect(spies.mcpShutdown).toHaveBeenCalledTimes(1);
    // Closed for real, not merely asked: the handle refuses work afterwards.
    await expect(result.jobStore?.get('any')).rejects.toThrow();

    // A second dispose is safe and runs nothing twice.
    await result.dispose();
    expect(spies.executorShutdown).toHaveBeenCalledTimes(1);
    expect(spies.jobStoreClose).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('start-stop-start leaves only the second runtime ticking', async () => {
    const first = await build();
    const perRuntime = vi.getTimerCount();
    expect(perRuntime).toBeGreaterThan(0);
    await first.dispose();

    const second = await build();
    expect(vi.getTimerCount()).toBe(perRuntime);
    await second.dispose();
    expect(vi.getTimerCount()).toBe(0);
  }, 60_000);

  it('a cleanup that throws does not stop the rest; dispose rejects with an AggregateError', async () => {
    const spies = spyOwners();
    spies.reconcilerStop.mockImplementation(() => {
      throw new Error('reconciler stuck');
    });
    const result = await build();

    const err = await result.dispose().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('reconciler stuck');
    // Everything around the failing step still ran.
    expect(spies.executorShutdown).toHaveBeenCalledTimes(1);
    expect(spies.jobStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.sessionStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.mcpShutdown).toHaveBeenCalledTimes(1);
    // Repeating the call does not re-run a half-failed teardown.
    await expect(result.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(spies.executorShutdown).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('a boot that fails in a later stage releases what the earlier stages opened', async () => {
    const spies = spyOwners();
    // Provider resolution runs AFTER infrastructure (sessions.db), tool
    // composition (goals.db, MCP) and plugin loading — an unregistered
    // provider throws there, with all of those already constructed.
    await expect(build({ ...CONFIG, provider: 'no-such-provider' })).rejects.toThrow(
      /not registered/,
    );

    expect(spies.sessionStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.contextLogClose).toHaveBeenCalledTimes(1);
    expect(spies.goalStoreClose).toHaveBeenCalledTimes(1);
    expect(spies.mcpShutdown).toHaveBeenCalledTimes(1);
    expect(spies.pluginsUnload).toHaveBeenCalledTimes(1);
    // The stages after the failure never ran, so nothing was left ticking.
    expect(spies.executorShutdown).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 60_000);

  // Pins the order `CreateAgentLoopResult.dispose` documents: workers stop
  // before the stores they write to close, sessions.db closes last of all.
  it('releases in the documented order', async () => {
    const spies = spyOwners();
    const runnerShutdown = vi.spyOn(GoalRunner.prototype, 'shutdown');
    const result = await build();
    await result.dispose();
    const at = (spy: { mock: { invocationCallOrder: number[] } }) =>
      spy.mock.invocationCallOrder[0] ?? Number.NaN;
    const order = [
      at(runnerShutdown),
      at(spies.reconcilerStop),
      at(spies.executorShutdown),
      at(spies.jobStoreClose),
      at(spies.pluginsUnload),
      at(spies.mcpShutdown),
      at(spies.goalStoreClose),
      at(spies.contextLogClose),
      at(spies.sessionStoreClose),
    ];
    expect(order.every((n) => Number.isFinite(n))).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  }, 60_000);

  // F06 follow-up — a REPLACED loop (chat `/model` switch) is drained before it
  // is disposed: its background jobs and goal runs finish rather than being
  // aborted with the shutdown reason.
  it('drain() waits on the executor and the goal runner, and aborts nothing', async () => {
    const executorDrain = vi.spyOn(BackgroundExecutor.prototype, 'drain');
    const goalsIdle = vi.spyOn(GoalRunner.prototype, 'whenIdle');
    const executorShutdown = vi.spyOn(BackgroundExecutor.prototype, 'shutdown');
    const result = await build();
    await result.drain();
    expect(executorDrain).toHaveBeenCalledTimes(1);
    expect(goalsIdle).toHaveBeenCalledTimes(1);
    expect(executorShutdown).not.toHaveBeenCalled();
    await result.dispose();
  }, 60_000);

  // Lifecycle audit G5 — proactive capture runs AFTER the turn's stream closes
  // (an LLM pass, then writes to memory/history/pending). It was in neither
  // `dispose()` nor `drain()`, so a stopping process or a `/model` switch
  // dropped a capture that was already in flight.
  it('waits for an in-flight memory capture in both drain() and dispose()', async () => {
    const whenIdle = vi.spyOn(MemoryCaptureRunner.prototype, 'whenIdle');
    const result = await build({ ...CONFIG, memoryCapture: { enabled: true } });
    await result.drain();
    expect(whenIdle).toHaveBeenCalledTimes(1);
    await result.dispose();
    expect(whenIdle).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('shuts the goal runner down before goals.db closes', async () => {
    const runnerShutdown = vi.spyOn(GoalRunner.prototype, 'shutdown');
    const goalStoreClose = vi.spyOn(SQLiteGoalStore.prototype, 'close');
    const result = await build();
    await result.dispose();

    expect(runnerShutdown).toHaveBeenCalledTimes(1);
    expect(goalStoreClose).toHaveBeenCalledTimes(1);
    const [shutdownOrder] = runnerShutdown.mock.invocationCallOrder;
    const [closeOrder] = goalStoreClose.mock.invocationCallOrder;
    expect(shutdownOrder).toBeLessThan(closeOrder ?? 0);
  }, 60_000);

  it('builds a per-personality memory backend once and closes it on dispose', async () => {
    // `personality.memory.provider` is resolved by context assembly on EVERY
    // turn through the loop's provider map. memory-vector opens memory.db in
    // its constructor, so a fresh instance per turn was one more connection
    // per turn, none ever closed.
    const vectorClose = vi.spyOn(VectorMemoryProvider.prototype, 'close');
    const result = await build();
    const providers = (
      result.loop as unknown as {
        memoryProviders: Map<string, (o?: Record<string, unknown>) => Promise<MemoryProvider>>;
      }
    ).memoryProviders;
    const resolveVector = providers.get('vector');
    expect(resolveVector).toBeDefined();

    const first = await resolveVector?.({});
    const second = await resolveVector?.({});
    expect(second).toBe(first);

    await result.dispose();
    expect(vectorClose).toHaveBeenCalledTimes(1);
  }, 60_000);
});
