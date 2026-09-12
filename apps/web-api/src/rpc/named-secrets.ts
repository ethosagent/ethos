import { os } from './context';

// Named-secrets vault manager. The raw value is written to the vault and is
// never echoed back — `list` returns masked previews only.

export const namedSecretsRouter = {
  list: os.namedSecrets.list.handler(({ context }) => context.namedSecrets.list()),

  // The derived provider roster — the browser cannot compute it, the
  // derivation needs the live tool registry.
  providers: os.namedSecrets.providers.handler(({ context }) => context.namedSecrets.providers()),

  create: os.namedSecrets.create.handler(({ input, context }) =>
    context.namedSecrets.create(input),
  ),

  delete: os.namedSecrets.delete.handler(({ input, context }) =>
    context.namedSecrets.delete(input),
  ),

  testKey: os.namedSecrets.testKey.handler(({ input, context }) =>
    context.namedSecrets.testKey(input),
  ),
};
