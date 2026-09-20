import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../../features/chat/service';
import { goalSseRoutes } from '../../routes/goal-sse';
import { kanbanSseRoutes } from '../../routes/kanban-sse';
import { sseRoutes } from '../../routes/sse';
import { HEARTBEAT_MS } from '../../routes/sse-heartbeat';
import type { GoalsService } from '../../services/goals.service';
import type { KanbanService } from '../../services/kanban.service';

// S2 / R6b: every `/sse/*` route (except `system-sse.ts`, which already pings
// its own way) writes an `: hb` comment every 15s while a connection is
// idle, so a held-open stream is never mistaken for dead by a proxy or by
// the SDK's own stall watchdog. Route-level tests, no auth harness — same
// pattern as `kanban-sse.test.ts` and `sse.test.ts` (auth on `/sse/*` is
// applied outside these route modules, in `routes/index.ts`).
//
// Fake timers: each route's poll/heartbeat timers are driven by
// `vi.advanceTimersByTimeAsync` rather than real waits.

describe('SSE heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function readOneChunk(response: Response): Promise<string> {
    if (!response.body) throw new Error('SSE response has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    reader.releaseLock();
    void response.body.cancel().catch(() => {});
    return value ? decoder.decode(value) : '';
  }

  it('/sse/sessions/:id emits `: hb` within 15s while idle', async () => {
    const chat = {
      subscribe: () => () => {},
      subscribeActivity: () => () => {},
    } as unknown as ChatService;
    const app = new Hono();
    app.route('/sse', sseRoutes({ chat }));

    const resPromise = app.request('/sse/sessions/sess-1');
    const chunkPromise = readOneChunk(await resPromise);
    // Idle stream: nothing else writes, so the only thing that can resolve
    // this read is the heartbeat timer.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(await chunkPromise).toContain(': hb');
  });

  it('/sse/activity emits `: hb` within 15s while idle', async () => {
    const chat = {
      subscribe: () => () => {},
      subscribeActivity: () => () => {},
    } as unknown as ChatService;
    const app = new Hono();
    app.route('/sse', sseRoutes({ chat }));

    const res = await app.request('/sse/activity');
    const chunkPromise = readOneChunk(res);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(await chunkPromise).toContain(': hb');
  });

  it('/sse/kanban/:team emits `: hb` within 15s while idle', async () => {
    const kanban = {
      getRecentEvents: async () => [],
      getEventsSince: async () => [],
    } as unknown as KanbanService;
    const app = new Hono();
    app.route('/sse', kanbanSseRoutes({ kanban }));

    const res = await app.request('/sse/kanban/analytics');
    const chunkPromise = readOneChunk(res);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(await chunkPromise).toContain(': hb');
  });

  it('/sse/goals/:id emits `: hb` within 15s while idle (goal still running)', async () => {
    const goals = {
      getEventsSince: async () => [],
      getGoal: async () => ({ id: 'g1', status: 'running' }),
    } as unknown as GoalsService;
    const app = new Hono();
    app.route('/sse', goalSseRoutes({ goals }));

    const res = await app.request('/sse/goals/g1');
    const chunkPromise = readOneChunk(res);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(await chunkPromise).toContain(': hb');
  });

  it('/sse/goals/:id stops the heartbeat once the goal reaches a terminal state', async () => {
    const goals = {
      getEventsSince: async () => [],
      getGoal: async () => ({ id: 'g1', status: 'completed' }),
    } as unknown as GoalsService;
    const app = new Hono();
    app.route('/sse', goalSseRoutes({ goals }));

    const res = await app.request('/sse/goals/g1');
    // Terminal state: the route writes `done` and returns without ever
    // arming a poll timer — draining the body should complete on its own,
    // with no dangling heartbeat interval left running.
    if (!res.body) throw new Error('SSE response has no body');
    const reader = res.body.getReader();
    await reader.read();
    reader.releaseLock();
    await res.body.cancel().catch(() => {});

    // No pending timers left over (the heartbeat was stopped, not just
    // unobserved).
    expect(vi.getTimerCount()).toBe(0);
  });
});
