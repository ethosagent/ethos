import type { PluginIsolationConfig } from '@ethosagent/config';
import { noopLogger } from '@ethosagent/logger';
import { createPluginActivator, PluginHostPool } from '@ethosagent/plugin-host';
import type { PluginActivator } from '@ethosagent/plugin-loader';
import { pluginCredentialPrefix } from '@ethosagent/plugin-sdk';
import type { Logger, SecretsResolver, Storage } from '@ethosagent/types';

export { PluginHostPool };

export interface CreatePluginHostPoolOptions {
  dataDir: string;
  storage: Storage;
  /** Absolute path of the host child entry (`apps/ethos/src/plugin-host-child.ts` or its bundle). */
  childEntry: string;
  /** `WiringConfig.pluginIsolation`; supplies the heap and hook-timeout limits. */
  config?: PluginIsolationConfig;
  logger?: Logger;
}

/**
 * The one pool an app host owns per process (plan plugin-process-isolation D4).
 * Nothing spawns until a plugin that resolves to `host` activates.
 *
 * `plugins.host.sandbox` is NOT passed: `PluginHostPoolOptions` has no sandbox
 * field until lane C adds one, so the setting is carried by config only.
 *
 * `onEvent` logs the three events an operator must see (`crashed`,
 * `circuit_open`, `registration_drift`) and drops the rest; the observability
 * lane (E) replaces this with `recordPluginHost*` helpers.
 */
export function createPluginHostPool(opts: CreatePluginHostPoolOptions): PluginHostPool {
  const logger = opts.logger ?? noopLogger;
  return new PluginHostPool({
    storage: opts.storage,
    dataDir: opts.dataDir,
    childEntry: opts.childEntry,
    logger,
    ...(opts.config
      ? { maxHeapMb: opts.config.maxHeapMb, hookTimeoutMs: opts.config.hookTimeoutMs }
      : {}),
    onEvent: (category, payload) => {
      if (
        category === 'plugin_host.crashed' ||
        category === 'plugin_host.circuit_open' ||
        category === 'plugin_host.registration_drift'
      ) {
        logger.warn(`[plugin-host] ${category}`, { component: 'plugin-host', ...payload });
      }
    },
  });
}

/**
 * A `PluginActivator` over a pool that may not exist yet. `getPool` is called on
 * the first hosted activation, so a loop with no hosted plugin never builds one.
 */
export function createLazyPluginActivator(
  getPool: () => PluginHostPool,
  opts: { baseUrl?: string; secrets?: SecretsResolver } = {},
): PluginActivator {
  let inner: PluginActivator | undefined;
  return {
    activate(req) {
      inner ??= createPluginActivator(getPool(), {
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        // D19: only key NAMES under plugins/<id>/ cross at spawn, never values.
        secretKeys: async (pluginId) => {
          if (!opts.secrets) return [];
          try {
            const prefix = pluginCredentialPrefix(pluginId);
            const refs = await opts.secrets.list(prefix);
            return refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
          } catch {
            return [];
          }
        },
      });
      return inner.activate(req);
    },
  };
}
