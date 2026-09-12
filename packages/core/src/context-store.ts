/**
 * A run-scoped key/value scratchpad handed to tools as `ToolContext.getContext`
 * / `setContext` (spread in `agent-loop/stages/tool-processing.ts`; one store per
 * `AgentLoop.run()`, pinned by `__tests__/context-store-per-run.test.ts`).
 *
 * NOTHING IN THE FRAMEWORK WRITES TO IT TODAY. Every `setContext` call in the
 * repo is in a test or in a plugin's own tool code, so the one framework-adjacent
 * READER — `extensions/tools-goals/src/index.ts`'s `ctx.getContext?.('userId')` —
 * always takes its `'default-user'` fallback. The store is a plugin-to-plugin
 * channel within a turn, not a place the framework publishes identity.
 *
 * Seeding `userId` here would NOT be a safe upgrade: goal rows are keyed by that
 * value, and web-api creates and lists goals under a hardcoded `'default-user'`
 * (`apps/web-api/src/services/goals.service.ts`), so a real id would split a
 * user's goals across two owners and hide the existing rows. Real user scoping
 * has to land on both sides at once — the surfaces' `userId` (`RunOptions.userId`,
 * already threaded as `ToolContext.userScopeId`) and web-api's reads — before
 * anything writes an identity into this store.
 */
export class ContextStore {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }

  asContextMethods(): {
    getContext: <T>(key: string) => T | undefined;
    setContext: <T>(key: string, value: T) => void;
  } {
    return {
      getContext: <T>(key: string) => this.get<T>(key),
      setContext: <T>(key: string, value: T) => this.set(key, value),
    };
  }
}
