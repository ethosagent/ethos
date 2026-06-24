import type { ExecutionBackendRegistry, Logger } from '@ethosagent/types';

/**
 * Default-deny trust gate for plugin-contributed execution backends (§A5).
 *
 * Execution backends are the HIGHEST-privilege class — they run model-directed,
 * possibly prompt-injected code. A plugin backend (name contains '/') is refused
 * unless the plugin id is in the `trustedExecutionPlugins` allowlist.
 *
 * Built-in backends (no '/' in name: 'local', 'docker', 'ssh') are always
 * allowed — they ship with the framework and are reviewed in-tree.
 *
 * The gate runs at resolution time (before any code runs on the backend), not
 * at registration time, so a plugin can always register its factory — it just
 * can't be used until trusted.
 */
export function isExecutionBackendAllowed(backendName: string, trustedPlugins?: string[]): boolean {
  // Built-in backends (no namespace separator) are always allowed.
  if (!backendName.includes('/')) return true;
  // No allowlist configured → default-deny for plugin backends.
  if (!trustedPlugins) return false;
  const pluginId = backendName.split('/')[0] ?? '';
  return trustedPlugins.includes(pluginId);
}

/**
 * Wrap an `ExecutionBackendRegistry` to enforce the trust gate at resolve time.
 * Registration passes through (plugins can always register), but `resolve()`
 * throws for untrusted plugin backends.
 */
export function guardedExecutionRegistry(
  inner: ExecutionBackendRegistry,
  trustedPlugins: string[] | undefined,
  log: Logger,
): ExecutionBackendRegistry {
  return {
    register: (name, factory) => inner.register(name, factory),
    resolve: async (name, ctx) => {
      if (!isExecutionBackendAllowed(name, trustedPlugins)) {
        const pluginId = name.split('/')[0] ?? '';
        const msg =
          `Execution backend "${name}" is from plugin "${pluginId}" which is not ` +
          `in the trustedExecutionPlugins allowlist. Execution backends are the ` +
          `highest-privilege class — add "${pluginId}" to trustedExecutionPlugins ` +
          `in your constitution or config to allow it.`;
        log.error(msg);
        throw new Error(msg);
      }
      return inner.resolve(name, ctx);
    },
    get: (name) => inner.get(name),
    list: () => inner.list(),
  };
}
