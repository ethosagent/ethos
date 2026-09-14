import { os } from './context';

// The model registry (T1.24, T2.2): list, the immediate-save writes, and the
// on-demand test. Every handler is one `ModelRegistryService` call.

/**
 * The rate-limit bucket this caller shares, alongside the tested subject.
 *
 * Same `_authMethod` read as `rpc/cron.ts` and `rpc/backup.ts` — it is the only
 * caller distinction a handler can make here, so bearer callers and cookie
 * callers get one bucket each. Absent means cookie.
 */
function callerOf(context: unknown): string {
  return (context as { _authMethod?: unknown })._authMethod === 'bearer' ? 'bearer' : 'cookie';
}

export const modelRegistryRouter = {
  list: os.modelRegistry.list.handler(({ context }) => context.modelRegistry.list()),
  upsert: os.modelRegistry.upsert.handler(({ input, context }) =>
    context.modelRegistry.upsert(input),
  ),
  setDefault: os.modelRegistry.setDefault.handler(({ input, context }) =>
    context.modelRegistry.setDefault(input),
  ),
  setRole: os.modelRegistry.setRole.handler(({ input, context }) =>
    context.modelRegistry.setRole(input),
  ),
  setRouting: os.modelRegistry.setRouting.handler(({ input, context }) =>
    context.modelRegistry.setRouting(input),
  ),
  remove: os.modelRegistry.remove.handler(({ input, context }) =>
    context.modelRegistry.remove(input),
  ),
  test: os.modelRegistry.test.handler(({ input, context }) =>
    context.modelRegistry.test(input, callerOf(context)),
  ),
  testAll: os.modelRegistry.testAll.handler(({ context }) =>
    context.modelRegistry.testAll(callerOf(context)),
  ),
  importChain: os.modelRegistry.importChain.handler(({ input, context }) =>
    context.modelRegistry.importChain(input),
  ),
  addProvider: os.modelRegistry.addProvider.handler(({ input, context }) =>
    context.modelRegistry.addProvider(input),
  ),
  updateProvider: os.modelRegistry.updateProvider.handler(({ input, context }) =>
    context.modelRegistry.updateProvider(input),
  ),
  removeProvider: os.modelRegistry.removeProvider.handler(({ input, context }) =>
    context.modelRegistry.removeProvider(input),
  ),
  moveProvider: os.modelRegistry.moveProvider.handler(({ input, context }) =>
    context.modelRegistry.moveProvider(input),
  ),
  setProviderFailover: os.modelRegistry.setProviderFailover.handler(({ input, context }) =>
    context.modelRegistry.setProviderFailover(input),
  ),
  setFallbackModel: os.modelRegistry.setFallbackModel.handler(({ input, context }) =>
    context.modelRegistry.setFallbackModel(input),
  ),
  testProvider: os.modelRegistry.testProvider.handler(({ input, context }) =>
    context.modelRegistry.testProvider(input, callerOf(context)),
  ),
};
