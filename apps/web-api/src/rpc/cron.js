import { os } from './context';
// Thin RPC shells for the cron namespace. Every handler is a single
// service call — no FS, no scheduler logic in here. Per the layered
// architecture rule, RPC handlers stay ≤10 lines each.
export const cronRouter = {
  list: os.cron.list.handler(({ context }) => context.cron.list()),
  get: os.cron.get.handler(({ input, context }) => context.cron.get(input.id)),
  create: os.cron.create.handler(({ input, context }) =>
    context.cron.create({
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      personalityId: input.personalityId,
      ...(input.missedRunPolicy !== undefined && { missedRunPolicy: input.missedRunPolicy }),
    }),
  ),
  update: os.cron.update.handler(({ input, context }) =>
    context.cron.update(input.id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.schedule !== undefined && { schedule: input.schedule }),
      ...(input.prompt !== undefined && { prompt: input.prompt }),
    }),
  ),
  delete: os.cron.delete.handler(async ({ input, context }) => {
    await context.cron.delete(input.id);
    return { ok: true };
  }),
  pause: os.cron.pause.handler(async ({ input, context }) => {
    await context.cron.pause(input.id);
    return { ok: true };
  }),
  resume: os.cron.resume.handler(async ({ input, context }) => {
    await context.cron.resume(input.id);
    return { ok: true };
  }),
  runNow: os.cron.runNow.handler(async ({ input, context }) => {
    const result = await context.cron.runNow(input.id);
    return { ok: true, output: result.output, ranAt: result.ranAt };
  }),
  history: os.cron.history.handler(({ input, context }) =>
    context.cron.history(input.id, input.limit),
  ),
};
