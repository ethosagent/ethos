import { os } from '../../../rpc/context';

export const chatEndIncognito = os.chat.endIncognito.handler(async ({ input, context }) => {
  const { scrubbed } = await context.chat.endIncognito(input.sessionId);
  return { ok: true as const, scrubbed };
});
