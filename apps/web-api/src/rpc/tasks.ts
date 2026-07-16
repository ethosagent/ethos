import { os } from './context';

// Read-only plus one cancel over the background JobStore. `list` scopes to a
// root session (see TasksService — no global list without a JobStore schema
// change); `get` merges the job with its ordered event trail; `cancel` requests
// cancellation. All mapping domain→wire lives in TasksService.

export const tasksRouter = {
  list: os.tasks.list.handler(({ input, context }) => context.tasks.list(input.rootSessionKey)),
  get: os.tasks.get.handler(({ input, context }) => context.tasks.get(input.id)),
  cancel: os.tasks.cancel.handler(({ input, context }) => context.tasks.cancel(input.id)),
};
