import { os } from './context';
// Thin RPC shells for the chat namespace. `chat.send` is fire-and-forget —
// the actual streamed response lands on SSE at /sse/sessions/:sessionId.
export const chatRouter = {
    send: os.chat.send.handler(({ input, context }) => context.chat.send({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        clientId: input.clientId,
        text: input.text,
        ...(input.personalityId ? { personalityId: input.personalityId } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
    })),
    abort: os.chat.abort.handler(async ({ input, context }) => {
        await context.chat.abort(input.sessionId);
        return { ok: true };
    }),
    steer: os.chat.steer.handler(({ input, context }) => {
        const ok = context.chat.steer(input.sessionId, input.text);
        return { ok };
    }),
};
