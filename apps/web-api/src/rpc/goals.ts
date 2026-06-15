import { os } from './context';

export const goalsRouter = {
  get: os.goals.get.handler(({ input, context }) => context.goals.get(input.id)),
  list: os.goals.list.handler(({ input, context }) =>
    context.goals.list({ status: input.status, limit: input.limit }),
  ),
  steer: os.goals.steer.handler(({ input, context }) =>
    context.goals.steer(input.id, input.message),
  ),
  cancel: os.goals.cancel.handler(({ input, context }) => context.goals.cancel(input.id)),
  resume: os.goals.resume.handler(({ input, context }) => context.goals.resume(input.id)),
  classify: os.goals.classify.handler(({ input, context }) =>
    context.goals.classify(input.message),
  ),
  create: os.goals.create.handler(({ input, context }) => context.goals.create(input)),
  toolResult: os.goals.toolResult.handler(({ input, context }) =>
    context.goals.toolResult(input.goalId, input.toolCallId),
  ),
};
