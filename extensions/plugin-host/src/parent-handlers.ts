import {
  type EthosPluginApi,
  pluginCredentialPrefix,
  pluginCredentialRef,
} from '@ethosagent/plugin-sdk';
import type { NotifyOptions, SimpleCompletion, Storage } from '@ethosagent/types';
import {
  type CapabilityDeps,
  createCapabilityHandlers,
  type SecretRefAuthorizer,
} from './capability-server';
import { type HandlerTable, RpcError } from './connection';
import { HOST_ERROR } from './errors';
import type { HostEventSink } from './events';
import type { HandlerContext } from './host-types';
import { RPC_ERROR } from './protocol';
import { isRecord } from './util';

export type { SecretRefAuthorizer } from './capability-server';

/**
 * Lane C's injection point (`secrets.ts`): decides whether a hosted plugin may
 * touch a secret ref. This default denies everything outside
 * `plugins/<id>/<key>`, so nothing is open until Lane C widens or narrows it.
 */
export const defaultAuthorizeSecretRef: SecretRefAuthorizer = (pluginId, ref, op) => {
  try {
    const prefix = pluginCredentialPrefix(pluginId);
    if (!ref.startsWith(prefix)) return false;
    // A list names a prefix, not a key.
    if (op === 'list') return true;
    return pluginCredentialRef(pluginId, ref.slice(prefix.length)) === ref;
  } catch {
    return false;
  }
};

/** The parent's own `PluginApiImpl` per plugin, bound by the activator (one per loop). */
export class ParentApis {
  private readonly bound = new Map<string, EthosPluginApi[]>();

  bind(pluginId: string, api: EthosPluginApi): void {
    const list = this.bound.get(pluginId) ?? [];
    if (!list.includes(api)) list.push(api);
    this.bound.set(pluginId, list);
  }

  unbind(pluginId: string, api: EthosPluginApi): void {
    const list = (this.bound.get(pluginId) ?? []).filter((a) => a !== api);
    if (list.length === 0) this.bound.delete(pluginId);
    else this.bound.set(pluginId, list);
  }

  /** The first bound loop's api answers host traffic (plan §13.12: the first loop's wins). */
  primary(pluginId: string): EthosPluginApi | undefined {
    return this.bound.get(pluginId)?.[0];
  }
}

/** What the composition root may inject. Everything is optional; defaults are closed. */
export interface ParentServices {
  authorizeSecretRef?: SecretRefAuthorizer;
  /** Key NAMES under `plugins/<id>/`, to answer `ethos/secrets.list`. */
  listSecretKeys?: (pluginId: string) => string[] | Promise<string[]>;
  /** `registries.llmFactory`, for `MonitorRunContext.llm` (a monitor has no call handle). */
  llmFactory?: () => SimpleCompletion;
}

export interface ParentHandlerDeps extends ParentServices {
  storage: Storage;
  hostHome: (pluginId: string) => string;
  apis: ParentApis;
  onEvent: HostEventSink;
}

function serialisable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function toNotify(raw: unknown): NotifyOptions {
  if (!isRecord(raw) || typeof raw.sessionKey !== 'string' || typeof raw.message !== 'string') {
    throw new RpcError(RPC_ERROR.invalidParams, 'notify needs sessionKey and message');
  }
  return {
    sessionKey: raw.sessionKey,
    message: raw.message,
    ...(typeof raw.startTurn === 'boolean' ? { startTurn: raw.startTurn } : {}),
    ...(isRecord(raw.payload) ? { payload: raw.payload } : {}),
  };
}

/**
 * The host -> parent handler table for one spawn of one plugin's host (plan
 * §5.3): every request is answered for THIS host's pluginId only. Secrets go
 * through `authorizeSecretRef` and then the parent's own `PluginApiImpl`
 * (D19); capabilities through a live `CallHandle` (§5.6); notify, diagnostics
 * and the event bus through the same api.
 */
export function createParentHandlers(
  deps: ParentHandlerDeps,
): (ctx: HandlerContext) => HandlerTable {
  const authorize = deps.authorizeSecretRef ?? defaultAuthorizeSecretRef;
  const capDeps: CapabilityDeps = {
    storage: deps.storage,
    hostHome: deps.hostHome,
    authorizeSecretRef: authorize,
    onEvent: deps.onEvent,
  };
  // Subscriptions outlive a spawn (the table is per spawn, the plugin is not).
  const subscriptions = new Map<string, Map<string, () => void>>();

  return (ctx) => {
    const { pluginId } = ctx;
    const api = (): EthosPluginApi => {
      const bound = deps.apis.primary(pluginId);
      if (!bound)
        throw new RpcError(RPC_ERROR.handlerFailed, `Plugin '${pluginId}' has no bound api`);
      return bound;
    };
    const keyOf = (ref: string, op: 'get' | 'set' | 'list'): string => {
      // The parent's own `PluginApiImpl` only reads and writes `plugins/<id>/<key>`, so a ref outside
      // that prefix cannot be served here however the authorizer answers (operator-approved foreign refs are Q2).
      if (!ref.startsWith(pluginCredentialPrefix(pluginId)) || !authorize(pluginId, ref, op)) {
        deps.onEvent('plugin_host.denied', { plugin_id: pluginId, kind: 'secret', ref });
        throw new RpcError(
          RPC_ERROR.denied,
          `${HOST_ERROR.secretDenied}: '${ref}' is not a secret this plugin may use`,
          { code: HOST_ERROR.secretDenied },
        );
      }
      return ref.slice(pluginCredentialPrefix(pluginId).length);
    };

    return {
      ...createCapabilityHandlers(ctx, capDeps),

      'ethos/secrets.get': async (params) => {
        if (!isRecord(params) || typeof params.ref !== 'string') {
          throw new RpcError(RPC_ERROR.invalidParams, 'secrets.get needs ref');
        }
        return api().getSecret(keyOf(params.ref, 'get'));
      },
      'ethos/secrets.set': async (params) => {
        if (
          !isRecord(params) ||
          typeof params.ref !== 'string' ||
          typeof params.value !== 'string'
        ) {
          throw new RpcError(RPC_ERROR.invalidParams, 'secrets.set needs ref and value');
        }
        await api().setSecret(keyOf(params.ref, 'set'), params.value);
        return null;
      },
      'ethos/secrets.list': async (params) => {
        const prefix =
          isRecord(params) && typeof params.prefix === 'string'
            ? params.prefix
            : pluginCredentialPrefix(pluginId);
        keyOf(prefix, 'list');
        const keys = (await deps.listSecretKeys?.(pluginId)) ?? [];
        const own = pluginCredentialPrefix(pluginId);
        return keys.map((k) => `${own}${k}`).filter((r) => r.startsWith(prefix));
      },

      'ethos/notify': async (params) => {
        if (!isRecord(params)) throw new RpcError(RPC_ERROR.invalidParams, 'notify needs opts');
        await api().notify(toNotify(params.opts));
        return null;
      },
      'ethos/diagnostics': (params) => {
        if (!isRecord(params)) return null;
        const d = api().diagnostics;
        if (
          params.kind === 'metric' &&
          typeof params.name === 'string' &&
          typeof params.value === 'number'
        ) {
          const labels: Record<string, string> = {};
          if (isRecord(params.labels)) {
            for (const [k, v] of Object.entries(params.labels))
              if (typeof v === 'string') labels[k] = v;
          }
          d.metric(params.name, params.value, labels);
        } else if (params.kind === 'event' && typeof params.message === 'string') {
          const data = isRecord(params.data) ? params.data : undefined;
          const level = params.level;
          if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
            d[level](params.message, data);
          }
        }
        return null;
      },

      'ethos/bus.emit': (params) => {
        if (!isRecord(params) || typeof params.event !== 'string') return null;
        if (!serialisable(params.payload)) {
          ctx.stats.droppedBus++;
          return null;
        }
        api().emit(params.event, params.payload);
        return null;
      },
      'ethos/bus.dropped': () => {
        ctx.stats.droppedBus++;
        return null;
      },
      'ethos/bus.subscribe': (params) => {
        if (!isRecord(params) || typeof params.event !== 'string') return null;
        const event = params.event;
        const perPlugin = subscriptions.get(pluginId) ?? new Map<string, () => void>();
        subscriptions.set(pluginId, perPlugin);
        perPlugin.get(event)?.();
        perPlugin.set(
          event,
          api().on(event, (payload) => {
            if (!serialisable(payload)) {
              ctx.stats.droppedBus++;
              return;
            }
            ctx.notifyHost('ethos/event', { type: 'bus', event, payload });
          }),
        );
        return null;
      },

      'ethos/monitor.llm': async (params) => {
        if (!isRecord(params) || typeof params.prompt !== 'string') {
          throw new RpcError(RPC_ERROR.invalidParams, 'monitor.llm needs prompt');
        }
        const llm = deps.llmFactory?.();
        if (!llm) throw new RpcError(RPC_ERROR.handlerFailed, 'no llm is configured for monitors');
        const o = params.options;
        return llm.complete(
          params.prompt,
          isRecord(o)
            ? {
                ...(typeof o.maxTokens === 'number' ? { maxTokens: o.maxTokens } : {}),
                ...(typeof o.model === 'string' ? { model: o.model } : {}),
                ...(typeof o.systemPrompt === 'string' ? { systemPrompt: o.systemPrompt } : {}),
              }
            : undefined,
        );
      },
    };
  };
}
