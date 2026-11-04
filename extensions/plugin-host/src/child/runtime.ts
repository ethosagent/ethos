import { dirname, join } from 'node:path';
import { PluginLoader } from '@ethosagent/plugin-loader';
import { pluginCredentialPrefix } from '@ethosagent/plugin-sdk';
import type { Logger, SecretsResolver, Storage, ToolResult } from '@ethosagent/types';
import { type HandlerTable, HostConnection, RpcError } from '../connection';
import { isModifyingHook, isVoidHook } from '../hook-names';
import { type ActivateResult, PROTOCOL_VERSION, type Registration, RPC_ERROR } from '../protocol';
import { isRecord } from '../util';
import { createRowSync, refuseOAuthConfig } from './api-sync';
import { buildChildContext, isToolExecuteRequest, parseLiveSnapshot } from './context';
import { installRowHandlers } from './handlers';
import { createChildRegistries, type RegistrationObserver } from './registries';
import { toolToWire } from './wire';

export interface PluginHostChildOptions {
  storage: Storage;
  /** Injected for tests. Defaults to the process streams. */
  stdin?: NodeJS.ReadableStream;
  exit?: (code: number) => void;
}

const DEACTIVATE_TIMEOUT_MS = 1_500;

/** Handlers after which the row sync is not worth its walk of every registry. */
const SKIP_ROW_SYNC: ReadonlySet<string> = new Set([
  'ethos/activate',
  'ethos/shutdown',
  'ethos/tool.execute',
  'ethos/ping',
  'ethos/cancel',
]);

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1_048_576);
}

type TrustTierValue = NonNullable<Parameters<PluginLoader['loadFromPluginDir']>[2]>;
const TIERS: readonly string[] = ['builtin', 'trusted-repo', 'community', 'untrusted'];
function toTier(value: unknown): TrustTierValue | undefined {
  if (typeof value !== 'string' || !TIERS.includes(value)) return undefined;
  return value as TrustTierValue;
}

/** Collects the loader's warnings so a failed load can be reported to the parent. */
class CapturingLogger implements Logger {
  readonly problems: string[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string): void {
    this.problems.push(message);
  }
  error(message: string): void {
    this.problems.push(message);
  }
  child(): Logger {
    return this;
  }
}

/** The plugin's `api.secrets` inside the host: no vault, only requests the parent authorises (D19). */
function ipcSecrets(
  conn: HostConnection,
  pluginId: () => string,
  knownKeys: () => string[],
): SecretsResolver {
  return {
    async get(ref) {
      const out = await conn.request<unknown>('ethos/secrets.get', { ref });
      return typeof out === 'string' ? out : null;
    },
    async set(ref, value) {
      await conn.request('ethos/secrets.set', { ref, value });
    },
    async delete() {
      throw new Error('Deleting a secret is not supported when a plugin runs in a plugin host.');
    },
    async list(prefix) {
      // Key NAMES were sent at spawn (D19); this rebuilds `plugins/<id>/<name>` so the SDK's
      // `hasSecret` priming (prefix list) works without a round trip.
      const own = pluginCredentialPrefix(pluginId());
      return knownKeys()
        .map((k) => `${own}${k}`)
        .filter((r) => prefix === undefined || r.startsWith(prefix));
    },
  };
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    work.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

/**
 * Entry point of the plugin host process (plan §5.3, §5.4.2). Speaks the
 * protocol on the ORIGINAL stdout; `process.stdout.write` is rebound to stderr
 * before any plugin code is imported so a plugin's console output can never
 * corrupt a frame. `console` itself is untouched.
 */
export function runPluginHostChild(opts: PluginHostChildOptions): void {
  const writeProtocol = process.stdout.write.bind(process.stdout);
  const toStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((...args: Parameters<typeof toStderr>) =>
    toStderr(...args)) as typeof process.stdout.write;

  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const input = opts.stdin ?? process.stdin;

  let pluginId = '';
  let activated = false;
  let loader: PluginLoader | null = null;
  let children: ReturnType<typeof createChildRegistries> | null = null;
  let secretKeys: string[] = [];
  let longLived = false;
  let rowSync: ReturnType<typeof createRowSync> | null = null;
  const inflight = new Map<number, AbortController>();

  // Handlers need the connection, so the table is filled in after construction.
  const handlers: HandlerTable = {};
  const conn = new HostConnection({
    write: (line) => {
      writeProtocol(line);
    },
    handlers,
    onViolation: () => exit(1),
  });

  const markLongLived = (): void => {
    if (longLived) return;
    longLived = true;
    if (activated) conn.notify('ethos/long-lived', { value: true });
  };

  /** Rows registered since the last look, announced to the parent. Runs after the load and after each request. */
  const announceNewRows = (): void => {
    if (!activated || !rowSync) return;
    for (const registration of rowSync.collect()) {
      conn.notify('ethos/registration.added', { registration });
    }
  };

  const observer: RegistrationObserver = {
    tool(tool) {
      if (!activated) return;
      conn.notify('ethos/registration.added', { registration: toolToWire(tool) });
    },
    hook(model, name) {
      if (!activated) return;
      conn.notify('ethos/registration.added', {
        registration: { kind: 'hook', model, name } satisfies Registration,
      });
    },
  };

  handlers['ethos/activate'] = async (params) => {
    if (
      !isRecord(params) ||
      typeof params.pluginId !== 'string' ||
      typeof params.dir !== 'string'
    ) {
      throw new RpcError(RPC_ERROR.invalidParams, 'ethos/activate needs pluginId and dir');
    }
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        RPC_ERROR.invalidParams,
        `protocol version ${String(params.protocolVersion)} is not supported (expected ${PROTOCOL_VERSION})`,
      );
    }
    if (loader) throw new RpcError(RPC_ERROR.invalidRequest, 'host is already activated');
    pluginId = params.pluginId;
    const hostHome = typeof params.hostHome === 'string' ? params.hostHome : process.cwd();
    secretKeys = Array.isArray(params.secretKeys)
      ? params.secretKeys.filter((k): k is string => typeof k === 'string')
      : [];
    children = createChildRegistries({
      observer: () => observer,
      conn,
      ...(typeof params.baseUrl === 'string' ? { baseUrl: params.baseUrl } : {}),
      pluginId,
      stateDir: dirname(hostHome),
      onLongLived: markLongLived,
    });
    const registries = children.registries;
    rowSync = createRowSync({
      rows: children.rows,
      data: children.data,
      api: () => loader?.getApi(pluginId),
      pages: () => {
        const page = registries.pluginPages?.get(pluginId);
        return page ? [page] : [];
      },
      renderers: () => registries.renderers?.values() ?? [],
      dataSources: () => registries.dataSources?.get(pluginId) ?? new Map<string, string>(),
    });
    const logger = new CapturingLogger();
    loader = new PluginLoader(children.registries, {
      storage: opts.storage,
      secrets: ipcSecrets(
        conn,
        () => pluginId,
        () => secretKeys,
      ),
      logger,
      dataDir: join(hostHome, '.ethos'),
    });
    // The dynamic import() lives inside PluginLoader (EX-005), never here (D13).
    await loader.loadFromPluginDir(params.dir, pluginId, toTier(params.tier));
    if (!loader.isLoaded(pluginId)) {
      loader = null;
      throw new RpcError(
        RPC_ERROR.handlerFailed,
        logger.problems.at(-1) ?? `Plugin '${pluginId}' failed to load in the plugin host`,
      );
    }
    try {
      refuseOAuthConfig(loader.getApi(pluginId));
    } catch (err) {
      await withTimeout(loader.unloadAll(), DEACTIVATE_TIMEOUT_MS);
      loader = null;
      throw new RpcError(RPC_ERROR.handlerFailed, err instanceof Error ? err.message : String(err));
    }
    const registrations: Registration[] = [];
    for (const tool of children.tools.recorded.values()) registrations.push(toolToWire(tool));
    for (const name of children.hooks.voidNames) {
      registrations.push({ kind: 'hook', model: 'void', name });
    }
    for (const name of children.hooks.modifyingNames) {
      registrations.push({ kind: 'hook', model: 'modifying', name });
    }
    registrations.push(...rowSync.collect());
    activated = true;
    const result: ActivateResult = {
      registrations,
      holdsLongLived: longLived,
      rssMb: rssMb(),
    };
    return result;
  };

  handlers['ethos/tool.execute'] = async (params, ctx): Promise<ToolResult> => {
    if (
      !isRecord(params) ||
      typeof params.name !== 'string' ||
      !isToolExecuteRequest(params.request)
    ) {
      throw new RpcError(RPC_ERROR.invalidParams, 'ethos/tool.execute needs name and request');
    }
    const request = params.request;
    const tool = children?.tools.get(params.name);
    if (!tool) {
      return { ok: false, code: 'not_available', error: `Tool '${params.name}' not found in host` };
    }
    const call = typeof params.call === 'string' ? params.call : '';
    const controller = new AbortController();
    if (ctx.id !== undefined) inflight.set(ctx.id, controller);
    try {
      const toolCtx = buildChildContext(
        request,
        call,
        controller.signal,
        conn,
        tool.capabilities ?? {},
        parseLiveSnapshot(params.live),
      );
      return await tool.execute(request.args, toolCtx);
    } catch (err) {
      return {
        ok: false,
        code: 'execution_failed',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (ctx.id !== undefined) inflight.delete(ctx.id);
    }
  };

  handlers['ethos/hook.fire'] = async (params) => {
    if (!isRecord(params) || typeof params.name !== 'string' || !children) return null;
    const hooks: {
      fireVoid(name: string, payload: unknown, allowed?: string[]): Promise<void>;
      fireModifying(name: string, payload: unknown, allowed?: string[]): Promise<unknown>;
    } = children.hooks;
    if (params.model === 'void' && isVoidHook(params.name)) {
      await hooks.fireVoid(params.name, params.payload, [pluginId]);
      return null;
    }
    if (params.model === 'modifying' && isModifyingHook(params.name)) {
      return hooks.fireModifying(params.name, params.payload, [pluginId]);
    }
    return null;
  };

  installRowHandlers(handlers, {
    conn,
    rows: () => (activated ? (children?.rows ?? null) : null),
    bus: () => children?.bus ?? null,
  });

  handlers['ethos/ping'] = async () => {
    const tools: Record<string, boolean> = {};
    for (const tool of children?.tools.recorded.values() ?? [])
      tools[tool.name] = toolToWire(tool).available;
    return { tools, rssMb: rssMb() };
  };

  handlers['ethos/cancel'] = (params) => {
    if (isRecord(params) && typeof params.id === 'number') inflight.get(params.id)?.abort();
    return null;
  };

  handlers['ethos/shutdown'] = async () => {
    if (loader) await withTimeout(loader.unloadAll(), DEACTIVATE_TIMEOUT_MS);
    setTimeout(() => exit(0), 20);
    return null;
  };

  // A registration made while serving a request (a slash handler, a route, a hook) is announced
  // once that request finishes. Activation and shutdown announce nothing themselves, and the
  // per-call tool.execute, ping and cancel stay off this path: a tool's own `execute` has no
  // registration surface, so a row it somehow added is announced after the next row handler.
  for (const [method, handle] of Object.entries(handlers)) {
    if (SKIP_ROW_SYNC.has(method)) continue;
    handlers[method] = async (params, ctx) => {
      try {
        return await handle(params, ctx);
      } finally {
        announceNewRows();
      }
    };
  }

  input.on('data', (chunk: Buffer | string) => conn.feed(chunk));
  input.on('end', () => exit(0));
  input.on('error', () => exit(1));
  conn.notify('ethos/ready', { protocolVersion: PROTOCOL_VERSION, pid: process.pid });
}
