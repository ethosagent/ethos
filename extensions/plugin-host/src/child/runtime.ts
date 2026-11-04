import { dirname, join } from 'node:path';
import { PluginLoader } from '@ethosagent/plugin-loader';
import type { Logger, SecretsResolver, Storage, ToolResult } from '@ethosagent/types';
import { type HandlerTable, HostConnection, RpcError } from '../connection';
import { isModifyingHook, isVoidHook } from '../hook-names';
import { type ActivateResult, PROTOCOL_VERSION, type Registration, RPC_ERROR } from '../protocol';
import { installApiTap } from './api-tap';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function ipcSecrets(conn: HostConnection, knownRefs: () => string[]): SecretsResolver {
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
      // Key names were sent at spawn; answering locally keeps hasSecret free of a round trip.
      return knownRefs().filter((r) => prefix === undefined || r.startsWith(prefix));
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
  let secretRefs: string[] = [];
  let longLived = false;
  const pending: Registration[] = [];
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

  const observer: RegistrationObserver = {
    add(reg) {
      // During activate() rows are collected into the activation result; afterwards each is announced.
      if (!activated) pending.push(reg);
      else conn.notify('ethos/registration.added', { registration: reg });
    },
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
    secretRefs = Array.isArray(params.secretKeys)
      ? params.secretKeys.filter((k): k is string => typeof k === 'string')
      : [];
    children = createChildRegistries({
      observer: () => observer,
      conn,
      ...(typeof params.baseUrl === 'string' ? { baseUrl: params.baseUrl } : {}),
      onLongLived: markLongLived,
    });
    installApiTap({
      rows: children.rows,
      stateDir: dirname(hostHome),
      add: (reg) => observer.add(reg),
      longLived: markLongLived,
    });
    const logger = new CapturingLogger();
    loader = new PluginLoader(children.registries, {
      storage: opts.storage,
      secrets: ipcSecrets(conn, () => secretRefs),
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
    const registrations: Registration[] = [];
    for (const tool of children.tools.recorded.values()) registrations.push(toolToWire(tool));
    for (const name of children.hooks.voidNames) {
      registrations.push({ kind: 'hook', model: 'void', name });
    }
    for (const name of children.hooks.modifyingNames) {
      registrations.push({ kind: 'hook', model: 'modifying', name });
    }
    registrations.push(...pending);
    activated = true;
    const result: ActivateResult = { registrations, holdsLongLived: longLived };
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
    return { tools };
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

  input.on('data', (chunk: Buffer | string) => conn.feed(chunk));
  input.on('end', () => exit(0));
  input.on('error', () => exit(1));
  conn.notify('ethos/ready', { protocolVersion: PROTOCOL_VERSION, pid: process.pid });
}
