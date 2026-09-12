import type { AgentLoop } from '@ethosagent/core';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { NotificationRouter, ToolRegistry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { LoopGoals } from '../goal-slash';
import { createLateBoundGoals } from '../late-goals';
import { adoptBootedLoop, type BootedLoop } from '../onboarding-boot';

// Onboarding `ethos serve` boots the real loop in-process, then hands it to the
// late-bound goal pair, the web API and the deferred tool registry. If one of
// those steps threw, the loop stayed built but half-adopted: never disposed,
// the goal pair still bound to it, and the web API reporting "already wired"
// on the retry. Adoption now rolls every earlier step back and disposes the
// loop, so the next boot starts clean.

function booted(): BootedLoop & { dispose: ReturnType<typeof vi.fn> } {
  const executor = {
    canExecute: () => true,
    startGoal: async () => {},
    steer: () => true,
    cancel: () => true,
    resume: async () => true,
  };
  const goals: LoopGoals = { store: new SQLiteGoalStore(':memory:'), executor };
  return {
    loop: {} as AgentLoop,
    goals,
    notificationRouter: {} as NotificationRouter,
    toolRegistry: {} as ToolRegistry,
    dispose: vi.fn(async () => {}),
  };
}

function seams(overrides: { bindAgentLoop?: () => () => Promise<void>; setInner?: () => void }) {
  const lateGoals = createLateBoundGoals();
  const unbindWeb = vi.fn(async () => {});
  const web = {
    bindAgentLoop: vi.fn(overrides.bindAgentLoop ?? (() => unbindWeb)),
  };
  const tools = { setInner: vi.fn(overrides.setInner ?? (() => {})) };
  return {
    lateGoals,
    unbindWeb,
    web,
    tools,
    adopt: { goals: lateGoals, web, tools, dangerPredicate: () => async () => null },
  };
}

describe('adoptBootedLoop', () => {
  it('hands the loop to every consumer when nothing fails', async () => {
    const b = booted();
    const s = seams({});
    await adoptBootedLoop(b, s.adopt);
    expect(s.lateGoals.goals.executor.canExecute()).toBe(true);
    expect(s.web.bindAgentLoop).toHaveBeenCalledWith(b.loop, expect.anything());
    expect(s.tools.setInner).toHaveBeenCalledWith(b.toolRegistry);
    expect(b.dispose).not.toHaveBeenCalled();
  });

  it('a web bind that throws unbinds the goals and disposes the loop, and a retry adopts', async () => {
    let fail = true;
    const unbindWeb = vi.fn(async () => {});
    const s = seams({
      bindAgentLoop: () => {
        if (fail) throw new Error('bind failed');
        return unbindWeb;
      },
    });
    const first = booted();
    await expect(adoptBootedLoop(first, s.adopt)).rejects.toThrow('bind failed');
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(s.lateGoals.goals.executor.canExecute()).toBe(false);
    expect(s.tools.setInner).not.toHaveBeenCalled();

    fail = false;
    const second = booted();
    await adoptBootedLoop(second, s.adopt);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(s.lateGoals.goals.executor.canExecute()).toBe(true);
  });

  it('a tool hand-over that throws after the web bind undoes the bind too', async () => {
    const s = seams({
      setInner: () => {
        throw new Error('duplicate tool');
      },
    });
    const b = booted();
    await expect(adoptBootedLoop(b, s.adopt)).rejects.toThrow('duplicate tool');
    expect(s.unbindWeb).toHaveBeenCalledTimes(1);
    expect(s.lateGoals.goals.executor.canExecute()).toBe(false);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });
});

// Everything the bind can carry in-process goes through it: MCP, the execution
// registry, the skills injector and the per-turn personality reload. What it
// cannot (cron, background tasks, voice lanes, dashboards-through-plugins) is
// named on `adoptBootedLoop` and surfaced as "restart needed" instead.
describe('adoptBootedLoop — the rest of the loop surfaces', () => {
  it('hands each bindable surface to the web API', async () => {
    const b = booted();
    const mcpManager = {} as never;
    const executionBackends = {} as never;
    const skillsInjector = {} as never;
    const refreshPersonalities = async () => {};
    const s = seams({});
    await adoptBootedLoop(
      { ...b, mcpManager, executionBackends, skillsInjector, refreshPersonalities },
      s.adopt,
    );
    expect(s.web.bindAgentLoop).toHaveBeenCalledWith(
      b.loop,
      expect.objectContaining({
        mcpManager,
        executionBackends,
        skillsInjector,
        refreshPersonalities,
      }),
    );
  });
});
