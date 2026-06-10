import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { GoalsService } from '../services/goals.service';

export interface GoalSseOptions {
  goals: GoalsService;
}

export function goalSseRoutes(opts: GoalSseOptions) {
  const app = new Hono();

  app.get('/goals/:id', async (c) => {
    const goalId = c.req.param('id');
    const lastIdHeader = c.req.header('Last-Event-ID');
    const sinceSeq = parseLastEventId(lastIdHeader);

    return streamSSE(c, async (stream) => {
      let lastSeq = sinceSeq;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      stream.onAbort(() => {
        if (pollTimer) clearInterval(pollTimer);
      });

      // Replay stored events (respecting Last-Event-ID for reconnect)
      const stored = await opts.goals.getEventsSince(goalId, lastSeq);
      for (const event of stored) {
        await stream.writeSSE({
          id: String(event.seq),
          data: JSON.stringify(event),
        });
        lastSeq = event.seq;
      }

      // Check current goal status
      const goal = await opts.goals.getGoal(goalId);
      if (!goal) {
        await stream.writeSSE({
          id: String(lastSeq + 1),
          data: JSON.stringify({ type: 'error', error: 'Goal not found' }),
        });
        return;
      }

      const terminalStatuses = new Set([
        'completed',
        'exhausted',
        'failed',
        'cancelled',
        'interrupted',
      ]);

      // For terminal states, send done and end after replay
      if (terminalStatuses.has(goal.status)) {
        await stream.writeSSE({
          id: String(lastSeq + 1),
          data: JSON.stringify({ type: 'done', goalId, status: goal.status }),
        });
        return;
      }

      // Poll for new events while goal is active
      pollTimer = setInterval(() => {
        void (async () => {
          const newEvents = await opts.goals.getEventsSince(goalId, lastSeq);
          for (const event of newEvents) {
            await stream.writeSSE({
              id: String(event.seq),
              data: JSON.stringify(event),
            });
            lastSeq = event.seq;
          }

          // Check if goal reached terminal state
          const current = await opts.goals.getGoal(goalId);
          if (!current || terminalStatuses.has(current.status)) {
            await stream.writeSSE({
              id: String(lastSeq + 1),
              data: JSON.stringify({
                type: 'done',
                goalId,
                status: current?.status ?? 'unknown',
              }),
            });
            if (pollTimer) clearInterval(pollTimer);
          }
        })();
      }, 1000);

      // Block until client disconnects (onAbort cleans up)
      await new Promise<void>(() => {});
    });
  });

  return app;
}

function parseLastEventId(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
