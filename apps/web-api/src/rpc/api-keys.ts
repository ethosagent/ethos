import { os } from './context';

export const apiKeysRouter = {
  create: os.apiKeys.create.handler(({ input, context }) => context.apiKeys.create(input)),

  list: os.apiKeys.list.handler(({ context }) => context.apiKeys.list()),

  revoke: os.apiKeys.revoke.handler(({ input, context }) => context.apiKeys.revoke(input.id)),
};
