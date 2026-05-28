import { os } from '../../../rpc/context';

export const sessionsFork = os.sessions.fork.handler(({ input, context }) =>
  context.sessions.fork(input.id, input.personalityId),
);
