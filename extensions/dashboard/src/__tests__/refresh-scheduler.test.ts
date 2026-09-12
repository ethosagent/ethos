import type { AgentLoop } from '@ethosagent/core';
import type { SessionStore } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardPanel } from '../dashboards.service';
import { DashboardRefreshScheduler, type DashboardRefreshSource } from '../refresh-scheduler';

// F06 — `stop()` must leave nothing running: the interval is cleared AND a
// sweep already in progress is cancelled and awaited, so the owner can close
// the dashboards DB (or dispose the loop) right after it resolves.

function promptPanel(id: string): DashboardPanel {
  return {
    id,
    dashboardId: 'd1',
    queryType: 'prompt',
    blockType: 'html',
    prompt: 'summarise',
    sqlQuery: null,
    pluginId: null,
    dataSourceId: null,
    htmlTemplate: null,
    paramDefaults: {},
    dependsOn: null,
    cronSchedule: '* * * * *',
    lastRunAt: null,
  } as unknown as DashboardPanel;
}

function makeSource(panels: DashboardPanel[]) {
  const writes: string[] = [];
  const source: DashboardRefreshSource = {
    list: () => [{ id: 'd1', cronSchedule: null }],
    listLivePanels: () => panels,
    get: () => ({ dashboard: { personalityId: 'p', paramsCurrent: {} }, panels }),
    updatePanelContent: (id) => writes.push(`content:${id}`),
    setPanelError: (id) => writes.push(`error:${id}`),
    clearPanelError: () => {},
    updatePanelParamDefaults: () => {},
  };
  return { source, writes };
}

/** A loop whose turn runs until its abort signal fires. */
function makeBlockingLoop(started: () => void): AgentLoop {
  return {
    async *run(_input: string, opts: { abortSignal?: AbortSignal }) {
      started();
      await new Promise<void>((resolve) => {
        if (opts.abortSignal?.aborted) resolve();
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
      yield { type: 'text_delta', text: 'partial' };
    },
  } as unknown as AgentLoop;
}

const sessions = {
  getSessionByKey: async () => null,
  deleteSession: async () => {},
} as unknown as SessionStore;

afterEach(() => {
  vi.useRealTimers();
});

describe('DashboardRefreshScheduler.stop (F06)', () => {
  it('clears the interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { source } = makeSource([]);
    const scheduler = new DashboardRefreshScheduler({
      dashboards: source,
      agentLoop: makeBlockingLoop(() => {}),
      sessions,
    });
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the sweep in progress, awaits it, and writes nothing for the cancelled panel', async () => {
    let turnStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      turnStarted = r;
    });
    const { source, writes } = makeSource([promptPanel('a'), promptPanel('b')]);
    const scheduler = new DashboardRefreshScheduler({
      dashboards: source,
      agentLoop: makeBlockingLoop(turnStarted),
      sessions,
    });

    const sweep = scheduler.tick();
    await started;
    await scheduler.stop();

    // The sweep has fully unwound by the time stop() resolves...
    let settled = false;
    void sweep.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
    // ...without a partial answer landing on panel `a`, and without going on
    // to refresh panel `b`.
    expect(writes).toEqual([]);
  });
});
