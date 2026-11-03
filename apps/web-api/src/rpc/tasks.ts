import { JOB_STEER_MAX_PENDING } from '@ethosagent/types';
import { ORPCError } from '@orpc/server';
import type { TasksEventsResult, TasksSteerResult } from '../services/tasks.service';
import { os } from './context';

// Reads plus cancel and steer over the background JobStore. `list` scopes to a
// root session (see TasksService — no global list without a JobStore schema
// change); `get` merges the job with its event trail and steers; `cancel`
// requests cancellation; `steer` queues a message the run reads at its next
// step; `events` is a cursor read of the trail. All mapping domain→wire lives
// in TasksService; the failure→status mapping below follows rpc/outbox.ts.

type Failure = Extract<TasksSteerResult | TasksEventsResult, { ok: false }>;

function refuse(result: Failure): never {
  const status = 'status' in result && result.status ? ` (${result.status})` : '';
  switch (result.reason) {
    case 'not_found':
      throw new ORPCError('NOT_FOUND', { status: 404, message: 'job not found' });
    case 'finished':
      throw new ORPCError('CONFLICT', { status: 409, message: `job already finished${status}` });
    case 'remote':
      throw new ORPCError('CONFLICT', {
        status: 409,
        message: 'job runs on a remote node and cannot take steers',
      });
    case 'unsupported':
      throw new ORPCError('CONFLICT', {
        status: 409,
        message: "this job's runner cannot take steers",
      });
    case 'full':
      throw new ORPCError('TOO_MANY_REQUESTS', {
        status: 429,
        message: `job already has ${JOB_STEER_MAX_PENDING} unread steers; wait for it to catch up`,
      });
    case 'too_long':
      throw new ORPCError('BAD_REQUEST', { status: 400, message: 'steer text is too long' });
    default:
      throw new ORPCError('NOT_AVAILABLE', {
        status: 503,
        message: 'background jobs are not available on this server',
      });
  }
}

export const tasksRouter = {
  list: os.tasks.list.handler(({ input, context }) => context.tasks.list(input.rootSessionKey)),
  get: os.tasks.get.handler(({ input, context }) => context.tasks.get(input.id)),
  cancel: os.tasks.cancel.handler(({ input, context }) => context.tasks.cancel(input.id)),
  steer: os.tasks.steer.handler(async ({ input, context }) => {
    const res = await context.tasks.steer(input.id, input.text);
    if (!res.ok) refuse(res);
    return { steerId: res.steerId };
  }),
  events: os.tasks.events.handler(async ({ input, context }) => {
    const res = await context.tasks.events(input.id, input.afterSeq, input.limit);
    if (!res.ok) refuse(res);
    return res.events;
  }),
};
