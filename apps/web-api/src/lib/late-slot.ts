/**
 * A slot whose value arrives after the surface around it was built — the
 * onboarding case: `createWebApi` runs before any loop exists, and
 * `bindAgentLoop` installs the loop's registries once the host boots it.
 *
 * Two shapes, because the services below hold their dependencies two ways:
 *  - `lateDelegate` for a dependency a service STORES (`this.x = opts.x`): the
 *    stored object is a delegating proxy, so every call resolves the current
 *    value. It needs a `fallback` — what answers before the real one is bound,
 *    which is the stand-in that surface already had (e.g. the passive MCP
 *    manager).
 *  - `lateFn` for a callback slot: a wrapper that forwards to whatever is
 *    installed, and does nothing while nothing is.
 * A dependency a service re-reads per call (`this.opts.x`) needs neither —
 * pass a getter property on its options literal.
 *
 * Pinned by __tests__/onboarding-bind-loop.test.ts.
 */
export function lateDelegate<T extends object>(current: () => T | undefined, fallback: T): T {
  return new Proxy(fallback, {
    get(_target, prop) {
      const target = current() ?? fallback;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A callback slot: forwards to the installed function, a no-op until there is one. */
export function lateFn<A extends unknown[]>(
  current: () => ((...args: A) => unknown) | undefined,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    await current()?.(...args);
  };
}
