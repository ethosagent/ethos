import { os } from '../../../rpc/context';

export const sessionsPin = os.sessions.pin.handler(({ input, context }) =>
  context.sessions.pin(input.id),
);
