import type { PluginIsolationConfig } from '@ethosagent/config';
import { noopLogger } from '@ethosagent/logger';
import { createPluginActivator, PluginHostPool } from '@ethosagent/plugin-host';
import type { PluginActivator } from '@ethosagent/plugin-loader';
import { pluginCredentialPrefix } from '@ethosagent/plugin-sdk';
import type {
  Logger,
  SecretsResolver,
  SimpleCompletion,
  Storage,
  ToolRegistry,
} from '@ethosagent/types';

export { PluginHostPool };

/**
 * The slice of `EthosObservability` the pool needs. Structural, so a test can
 * pass a fake and so the pool never depends on the adapter class.
 */
export interface PluginHostObservability {
  recordPluginHostEvent(category: string, payload: Record<string, unknown>): void;
  startPluginCallSpan(opts: {
    name: string;
    attrs: Record<string, unknown>;
  }): (status: 'ok' | 'error', attrs: Record<string, unknown>) => void;
}

export interface CreatePluginHostPoolOptions {
  dataDir: string;
  storage: Storage;
  /** Absolute path of the host child entry (`apps/ethos/src/plugin-host-child.ts` or its bundle). */
  childEntry: string;
  /** `WiringConfig.pluginIsolation`; supplies the heap and hook-timeout limits. */
  config?: PluginIsolationConfig;
  logger?: Logger;
  /**
   * Resolved lazily on the first event or call, so building the pool never opens
   * observability.db. Absent or returning `undefined`: events are only logged
   * and no `plugin_call` span is written.
   */
  observability?: () => PluginHostObservability | undefined;
}

/**
 * The one pool an app host owns per process (plan plugin-process-isolation D4).
 * Nothing spawns until a plugin that resolves to `host` activates.
 *
 * `plugins.host.sandbox` is passed through: `auto` wraps each host in the OS
 * wrapper and fails the plugin load when none works (D22).
 *
 * `onEvent` records every host event through `observability` (fail-open) and
 * also logs the three an operator must see (`crashed`, `circuit_open`,
 * `registration_drift`). `onSpan` writes one `plugin_call` span per IPC call
 * with `traceId: ''`, joined to its turn by the `tool_call_id` attribute.
 */
export function createPluginHostPool(opts: CreatePluginHostPoolOptions): PluginHostPool {
  const logger = opts.logger ?? noopLogger;
  return new PluginHostPool({
    storage: opts.storage,
    dataDir: opts.dataDir,
    childEntry: opts.childEntry,
    logger,
    ...(opts.config
      ? {
          maxHeapMb: opts.config.maxHeapMb,
          hookTimeoutMs: opts.config.hookTimeoutMs,
          sandbox: opts.config.sandbox,
        }
      : {}),
    onSpan: (start) => {
      const obs = safeObservability(opts.observability);
      if (!obs) return () => undefined;
      const close = obs.startPluginCallSpan({
        name: start.name,
        attrs: {
          plugin_id: start.pluginId,
          ...(start.toolCallId ? { tool_call_id: start.toolCallId } : {}),
          ...(start.sessionId ? { session_id: start.sessionId } : {}),
        },
      });
      return (end) =>
        close(end.outcome === 'ok' ? 'ok' : 'error', {
          req_bytes: end.reqBytes,
          res_bytes: end.resBytes,
          ipc_ms: Math.round(end.ipcMs * 1000) / 1000,
          ...(end.hostMs !== undefined ? { host_ms: Math.round(end.hostMs * 1000) / 1000 } : {}),
          outcome: end.outcome,
        });
    },
    onEvent: (category, payload) => {
      safeObservability(opts.observability)?.recordPluginHostEvent(category, payload);
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

function safeObservability(
  get: (() => PluginHostObservability | undefined) | undefined,
): PluginHostObservability | undefined {
  try {
    return get?.();
  } catch {
    return undefined;
  }
}

/**
 * A `PluginActivator` over a pool that may not exist yet. `getPool` is called on
 * the first hosted activation, so a loop with no hosted plugin never builds one.
 */
export function createLazyPluginActivator(
  getPool: () => PluginHostPool,
  opts: {
    baseUrl?: string;
    secrets?: SecretsResolver;
    /** The loop's `registries.llmFactory`, read lazily (it is assigned after load). */
    llmFactory?: () => SimpleCompletion | undefined;
    /** The loop's tool registry, so a hosted tool cannot shadow a built-in. */
    tools?: Pick<ToolRegistry, 'get' | 'getPluginId'>;
  } = {},
): PluginActivator {
  let inner: PluginActivator | undefined;
  return {
    activate(req) {
      inner ??= createPluginActivator(getPool(), {
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.llmFactory ? { llmFactory: opts.llmFactory } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
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
