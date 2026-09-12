import { type AgentEvent, AgentLoop } from '@ethosagent/core';
import { EthosError } from '@ethosagent/types';

export interface PendingLoopDeps {
  /** The loop bound so far (`CreateWebApiResult.bindAgentLoop`), if any. */
  bound: () => AgentLoop | undefined;
  /** Ask the host to boot and bind the real loop; resolves without binding
   *  while setup is still missing. */
  boot?: () => Promise<unknown>;
}

/**
 * The loop every web-api service holds before the real one exists (onboarding
 * `ethos serve`): one delegating object, so no service needs to know the loop
 * arrives late. Once a loop is bound, every member — method or property —
 * resolves on it. Before that:
 *  - `run` asks the host to boot (`boot`) and forwards to whatever is bound
 *    afterwards, or yields a SETUP_REQUIRED error event;
 *  - any other `AgentLoop` method throws `NOT_CONFIGURED` (503 over the wire),
 *    never a TypeError;
 *  - a property (`hooks`, `clarifyBridge`) reads `undefined` — the "not wired"
 *    value its readers already handle.
 * Pinned by __tests__/lib/pending-loop.test.ts.
 */
export function createPendingLoop(deps: PendingLoopDeps): AgentLoop {
  async function* run(...args: Parameters<AgentLoop['run']>): AsyncGenerator<AgentEvent> {
    if (!deps.bound() && deps.boot) await deps.boot();
    const loop = deps.bound();
    if (loop) {
      yield* loop.run(...args);
      return;
    }
    yield {
      type: 'error',
      error: 'Setup required — complete onboarding first.',
      code: 'SETUP_REQUIRED',
    };
  }

  return new Proxy({} as AgentLoop, {
    get(_target, prop) {
      if (prop === 'run') return run;
      const loop = deps.bound();
      if (loop) {
        const value: unknown = Reflect.get(loop, prop, loop);
        return typeof value === 'function' ? value.bind(loop) : value;
      }
      // A method is known from the class itself — no per-method list to keep
      // in step with AgentLoop. Read as a descriptor so no getter runs.
      const isMethod =
        typeof Object.getOwnPropertyDescriptor(AgentLoop.prototype, prop)?.value === 'function';
      if (!isMethod) return undefined;
      return () => {
        throw new EthosError({
          code: 'NOT_CONFIGURED',
          cause: 'The agent is not running yet.',
          action: 'Finish setup — the agent starts as soon as a provider is configured.',
        });
      };
    },
  });
}
