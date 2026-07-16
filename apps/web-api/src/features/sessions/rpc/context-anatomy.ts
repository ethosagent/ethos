import { os } from '../../../rpc/context';

export const sessionsContextAnatomy = os.sessions.contextAnatomy.handler(({ input, context }) =>
  context.sessions.contextAnatomy(input.id),
);
