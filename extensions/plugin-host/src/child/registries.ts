import { DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import {
  DiagnosticStore,
  PluginEventBus,
  type PluginRegistries,
  type PluginRouteEntry,
} from '@ethosagent/plugin-sdk';
import type {
  CliSubcommandContext,
  ContextInjector,
  DiagnosticEvent,
  DiagnosticMetric,
  DocumentExtractor,
  DocumentExtractorRegistry,
  ModifyingHooks,
  NotificationRouter,
  PersonalityRegistry,
  PluginHealthCheck,
  PostTurnEvaluator,
  SimpleCompletion,
  SlashCommandContext,
  Tool,
  ToolInvocationFilter,
  VoidHooks,
} from '@ethosagent/types';
import type { HostConnection } from '../connection';
import type { Registration } from '../protocol';

/** Registrations the plugin makes, observed as they happen. */
export interface RegistrationObserver {
  /** A non-tool, non-hook row, reported by the api tap. */
  add(reg: Registration): void;
  tool(tool: Tool): void;
  hook(model: 'void' | 'modifying', name: string): void;
}

class RecordingToolRegistry extends DefaultToolRegistry {
  readonly recorded = new Map<string, Tool>();

  constructor(private readonly observer: () => RegistrationObserver) {
    super();
  }

  override register(tool: Tool, opts?: { pluginId?: string }): void {
    super.register(tool, opts);
    this.recorded.set(tool.name, tool);
    this.observer().tool(tool);
  }
}

/**
 * A real `DefaultHookRegistry`, so `fireModifying` merges exactly as it does
 * in-process (first non-null value per key wins, throw skipped), that also
 * reports which hook names the plugin touched.
 */
export class RecordingHookRegistry extends DefaultHookRegistry {
  readonly voidNames = new Set<string>();
  readonly modifyingNames = new Set<string>();

  constructor(private readonly observer: () => RegistrationObserver) {
    super();
  }

  override registerVoid<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
    opts?: { pluginId?: string; failurePolicy?: 'fail-open' | 'fail-closed' },
  ): () => void {
    if (!this.voidNames.has(name)) {
      this.voidNames.add(name);
      this.observer().hook('void', name);
    }
    return super.registerVoid(name, handler, opts);
  }

  override registerModifying<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
    opts?: { pluginId?: string },
  ): () => void {
    if (!this.modifyingNames.has(name)) {
      this.modifyingNames.add(name);
      this.observer().hook('modifying', name);
    }
    return super.registerModifying(name, handler, opts);
  }
}

/**
 * A registry that refuses every use with an error naming the SDK method (plan
 * §4.2, D9). The throw happens inside the plugin's `activate()`, so the load
 * fails through the loader's normal failure path instead of half-working.
 */
export const UNSUPPORTED = (method: string): string =>
  `${method} is not supported when a plugin runs in a plugin host. Set this plugin to in-process (plugins.isolation) to use it.`;

function unsupported<T extends object>(method: string): T {
  const refuse = (): never => {
    throw new Error(UNSUPPORTED(method));
  };
  return new Proxy({} as T, {
    get: () => refuse,
    has: () => true,
  });
}

/** A registry whose listed members are accepted and every other member is refused. */
function acceptOnly<T extends object>(method: string, impl: Partial<T>): T {
  const refuse = (): never => {
    throw new Error(UNSUPPORTED(method));
  };
  return new Proxy({} as T, {
    get: (_t, prop) => (prop in impl ? Reflect.get(impl, prop) : refuse),
    has: () => true,
  });
}

/** Bus: an emit goes to the parent's bus; a subscribe makes the parent forward matching events back (plan §4.2). */
export class BridgeEventBus extends PluginEventBus {
  constructor(
    private readonly conn: HostConnection,
    private readonly onSubscribe: () => void,
  ) {
    super();
  }

  override emit(event: string, payload: unknown): void {
    let serialisable = false;
    try {
      serialisable = JSON.stringify(payload) !== undefined;
    } catch {
      // circular, BigInt...: dropped and counted below
    }
    if (!serialisable) {
      this.conn.notify('ethos/bus.dropped', { event });
      return;
    }
    this.conn.notify('ethos/bus.emit', { event, payload });
  }

  override on(event: string, handler: (payload: unknown) => void): () => void {
    this.conn.notify('ethos/bus.subscribe', { event });
    this.onSubscribe();
    return super.on(event, handler);
  }

  /** An event the parent forwarded: deliver to this plugin's own subscribers. */
  deliver(event: string, payload: unknown): void {
    super.emit(event, payload);
  }
}

/** `api.diagnostics` / `registries.diagnostics` in the host: one-way notifications into the parent's store. */
class ForwardingDiagnostics extends DiagnosticStore {
  constructor(private readonly conn: HostConnection) {
    super();
  }
  override pushEvent(event: DiagnosticEvent): void {
    this.conn.notify('ethos/diagnostics', {
      kind: 'event',
      level: event.level,
      message: event.message,
      ...(event.data ? { data: event.data } : {}),
    });
  }
  override pushMetric(metric: DiagnosticMetric): void {
    this.conn.notify('ethos/diagnostics', {
      kind: 'metric',
      name: metric.name,
      value: metric.value,
      ...(metric.labels ? { labels: metric.labels } : {}),
    });
  }
  /** The parent's store is the parent's: a host cleanup must not clear it. */
  override clearPlugin(): void {}
}

/** The rows the plugin registered, index-aligned with the registrations sent to the parent. */
export interface ChildRows {
  injectors: ContextInjector[];
  filters: ToolInvocationFilter[];
  evaluators: PostTurnEvaluator[];
  routes: PluginRouteEntry[];
  healthChecks: PluginHealthCheck[];
  extractors: DocumentExtractor[];
  slash: Map<string, (args: string, ctx: SlashCommandContext) => Promise<string>>;
  cli: Map<string, (ctx: CliSubcommandContext) => Promise<number>>;
}

export interface ChildRegistries {
  registries: PluginRegistries;
  tools: RecordingToolRegistry;
  hooks: RecordingHookRegistry;
  rows: ChildRows;
  bus: BridgeEventBus;
}

export interface ChildRegistryOptions {
  observer: () => RegistrationObserver;
  conn: HostConnection;
  baseUrl?: string;
  /** A monitor started: the host now holds a long-lived thing (eager restart). */
  onLongLived: () => void;
}

export function createChildRegistries(opts: ChildRegistryOptions): ChildRegistries {
  const { conn } = opts;
  const tools = new RecordingToolRegistry(opts.observer);
  const hooks = new RecordingHookRegistry(opts.observer);
  const injectors: ContextInjector[] = [];
  const rows: ChildRows = {
    injectors,
    filters: [],
    evaluators: [],
    routes: [],
    healthChecks: [],
    extractors: [],
    slash: new Map(),
    cli: new Map(),
  };
  const bus = new BridgeEventBus(conn, opts.onLongLived);
  const notificationRouter: NotificationRouter = {
    async route(_pluginId, notifyOpts) {
      await conn.request('ethos/notify', { opts: notifyOpts });
    },
    register: () => undefined,
    deregister: () => undefined,
  };
  const extractorRegistry: DocumentExtractorRegistry = {
    register: () => undefined,
    for: () => undefined,
    list: () => [],
  };
  const llm: SimpleCompletion = {
    async complete(prompt, options) {
      const out = await conn.request('ethos/monitor.llm', { prompt, options });
      if (typeof out !== 'string') throw new Error('malformed llm response from the parent');
      return out;
    },
  };
  const registries: PluginRegistries = {
    tools,
    hooks,
    injectors,
    injectorPluginIds: new Map(),
    filters: rows.filters,
    evaluators: rows.evaluators,
    routes: rows.routes,
    eventBus: bus,
    notificationRouter,
    diagnostics: new ForwardingDiagnostics(conn),
    documentExtractors: extractorRegistry,
    llmFactory: () => llm,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    // Data: recorded by the api tap, which the registry merely has to accept.
    personalities: acceptOnly<PersonalityRegistry>('registerPersonality', {
      define: () => undefined,
    }),
    oauthRegistry: acceptOnly('registerOAuthProfile', {
      registerProfile: () => undefined,
      registerCustomFlow: () => {
        throw new Error(UNSUPPORTED('registerCustomOAuthFlow'));
      },
    }),
    contextEngines: unsupported('registerContextEngine'),
    llmProviders: unsupported('registerLLMProvider'),
    memoryProviders: unsupported('registerMemoryProvider'),
    storageBackends: unsupported('registerStorage'),
    executionBackends: unsupported('registerExecutionBackend'),
    platformAdapters: unsupported('registerPlatformAdapter'),
    sttProviders: unsupported('registerSttProvider'),
    ttsProviders: unsupported('registerTtsProvider'),
  };
  return { registries, tools, hooks, rows, bus };
}
