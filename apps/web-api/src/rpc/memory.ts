import { os } from './context';

// Thin RPC shells for the memory namespace.

export const memoryRouter = {
  list: os.memory.list.handler(({ input, context }) =>
    context.memory.list(input.personalityId, { userId: input.userId }),
  ),

  get: os.memory.get.handler(({ input, context }) =>
    context.memory.get(input.store, input.personalityId, { userId: input.userId }),
  ),

  write: os.memory.write.handler(({ input, context }) =>
    context.memory.write(input.store, input.content, input.personalityId, {
      userId: input.userId,
    }),
  ),

  listUsers: os.memory.listUsers.handler(({ context }) => context.memory.listUsers()),

  history: os.memory.history.handler(({ input, context }) =>
    context.memory.history(input.personalityId, {
      key: input.key,
      source: input.source,
      sinceMs: input.sinceMs,
      untilMs: input.untilMs,
      limit: input.limit,
      cursor: input.cursor,
    }),
  ),

  historyBlob: os.memory.historyBlob.handler(({ input, context }) =>
    context.memory.historyBlob(input.personalityId, input.blob),
  ),

  restore: os.memory.restore.handler(({ input, context }) =>
    context.memory.restore(input.personalityId, input.slug),
  ),

  pendingList: os.memory.pendingList.handler(({ input, context }) =>
    context.memory.pendingList(input.personalityId),
  ),

  pendingApprove: os.memory.pendingApprove.handler(({ input, context }) =>
    context.memory.pendingApprove(input.personalityId, input.id),
  ),

  pendingReject: os.memory.pendingReject.handler(({ input, context }) =>
    context.memory.pendingReject(input.personalityId, input.id),
  ),
};
