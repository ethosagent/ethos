import { os } from '../../../rpc/context';

export const sessionsList = os.sessions.list.handler(({ input, context }) =>
  context.sessions.list({
    ...(input.q !== undefined ? { q: input.q } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.personalityId ? { personalityId: input.personalityId } : {}),
  }),
);
