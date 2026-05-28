import { os } from '../../../rpc/context';

export const chatSteer = os.chat.steer.handler(({ input, context }) => {
  const ok = context.chat.steer(input.sessionId, input.text);
  return { ok };
});
