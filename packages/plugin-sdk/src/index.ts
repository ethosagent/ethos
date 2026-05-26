import type {
  ContextEngine,
  ContextEngineRegistry,
  ContextInjector,
  HookRegistry,
  LLMProviderFactory,
  LLMProviderRegistry,
  MemoryProviderFactory,
  MemoryProviderRegistry,
  ModifyingHooks,
  PersonalityConfig,
  PersonalityRegistry,
  PlatformAdapterFactory,
  PostTurnEvaluator,
  Storage,
  Tool,
  ToolInvocationFilter,
  ToolRegistry,
  VoidHooks,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// CredentialStorage — Storage + synchronous existence check
// ---------------------------------------------------------------------------

export interface CredentialStorage extends Storage {
  existsSync(path: string): boolean;
}

// ---------------------------------------------------------------------------
// HTTP route types — plugin-registered API endpoints
// ---------------------------------------------------------------------------

export interface PluginHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | string;
  query: Record<string, string>;
}

export interface PluginHttpResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PluginRouteEntry {
  pluginId: string;
  method: string;
  path: string;
  handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
}

// ---------------------------------------------------------------------------
// PluginEventBus — lightweight pub/sub for inter-plugin communication
// ---------------------------------------------------------------------------

export class PluginEventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const h of set) {
        // Fail-open: handler errors must not block other handlers or the emitter.
        // Matches the void-hook execution model in HookRegistry.
        try {
          h(payload);
        } catch {
          /* fail-open by design */
        }
      }
    }
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    const set = this.handlers.get(event);
    if (set) set.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}

// ---------------------------------------------------------------------------
// OAuth types — shape declared in v2.1; implementation deferred to v2.2
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  buildAuthUrl(opts: { redirectUri: string; state: string }): string;
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken?: string }>;
}

export interface OAuthCoordinator {
  beginFlow(opts: {
    pluginId: string;
    sessionKey: string;
    config: OAuthConfig;
    pendingUserMessage: string;
  }): string;
}

// ---------------------------------------------------------------------------
// Plugin module shape — what every plugin file must export
// ---------------------------------------------------------------------------

export interface EthosPlugin {
  activate(api: EthosPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// EthosPluginApi — passed to activate()
// ---------------------------------------------------------------------------

export interface EthosPluginApi {
  /** Unique identifier for this plugin instance. */
  readonly pluginId: string;

  /** Register a tool that will appear in the LLM's tool list. */
  registerTool(tool: Tool): void;

  /** Register a void hook (fire-and-forget, runs in parallel). */
  registerVoidHook<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
  ): void;

  /** Register a modifying hook (sequential, can amend prompt/args). */
  registerModifyingHook<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
  ): void;

  /** Register a context injector (adds content to the system prompt). */
  registerInjector(injector: ContextInjector): void;

  /** Register a custom personality. */
  registerPersonality(config: PersonalityConfig): void;

  /** E4 — register a custom context-compaction engine. The engine becomes
   *  selectable via `personality.context_engine: <engine.name>`. */
  registerContextEngine(engine: ContextEngine): void;

  /** Register a named LLM provider factory. Usable in config.yaml via
   *  `provider: <name>` or in personality-level model routing. */
  registerLLMProvider(name: string, factory: LLMProviderFactory): void;

  /** Register a named memory provider factory. Personalities opt in via
   *  `memory.provider: <name>` in their config.yaml. */
  registerMemoryProvider(name: string, factory: MemoryProviderFactory): void;

  /** Register a platform adapter factory. Teams opt in via `channels:` block
   *  in their manifest. */
  registerPlatformAdapter(name: string, factory: PlatformAdapterFactory): void;

  /** Check whether a secret exists (synchronous). */
  hasSecret(key: string): boolean;

  /** Read a secret value. Returns null if the secret doesn't exist or no
   *  credential storage is configured. */
  getSecret(key: string): Promise<string | null>;

  /** Write a secret value + metadata. Throws if no credential storage is
   *  configured. */
  setSecret(key: string, value: string): Promise<void>;

  /** Register a handler called after `setSecret`. Returns an unsubscribe fn. */
  onCredentialUpdate(handler: (key: string) => void | Promise<void>): () => void;

  /** Register a tool invocation filter (v2). */
  registerToolFilter(filter: ToolInvocationFilter): void;

  /** Register a post-turn evaluator (v2). */
  registerEvaluator(evaluator: PostTurnEvaluator): void;

  /** Register an HTTP route served by the host. */
  registerRoute(opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
  }): void;

  /** Emit an event on the shared event bus. */
  emit(event: string, payload: unknown): void;

  /** Subscribe to an event on the shared event bus. Returns an unsubscribe fn. */
  on(event: string, handler: (payload: unknown) => void): () => void;

  /** Register an OAuth config for this plugin (v2.2 implementation). */
  registerOAuth(config: OAuthConfig): void;

  /** Return the host's base URL, if configured. */
  getBaseUrl(): string | undefined;
}

// ---------------------------------------------------------------------------
// PluginRegistries — injected into PluginApiImpl by the loader
// ---------------------------------------------------------------------------

export interface PluginRegistries {
  tools: ToolRegistry;
  hooks: HookRegistry;
  /** Flat injector list shared with AgentLoop. Plugin-registered entries are
   *  also tracked in `injectorPluginIds` so AgentLoop can gate by personality. */
  injectors: ContextInjector[];
  /** Maps each plugin-registered injector to its plugin id.
   *  Built-in injectors are absent from this map (they always fire). */
  injectorPluginIds: Map<ContextInjector, string>;
  personalities: PersonalityRegistry;
  /** E4 — Optional context-engine registry. When present, plugins can
   *  contribute custom engines via `registerContextEngine`. Wiring layers
   *  that don't expose a registry leave this undefined; calls to
   *  `registerContextEngine` then no-op with a clear error. */
  contextEngines?: ContextEngineRegistry;
  /** LLM provider registry. Plugins contribute custom providers via
   *  `registerLLMProvider`. Required in v2 hosts. */
  llmProviders: LLMProviderRegistry;
  /** Memory provider registry. Plugins contribute custom backends via
   *  `registerMemoryProvider`. Required in v2 hosts. */
  memoryProviders: MemoryProviderRegistry;
  /** Platform adapter registry. Maps adapter names to factories. */
  platformAdapters?: Map<string, PlatformAdapterFactory>;
  /** v2 — Tool invocation filters. Plugins register filters that can
   *  approve/deny/modify tool calls before execution. */
  filters?: ToolInvocationFilter[];
  /** v2 — Post-turn evaluators. Plugins register evaluators that run
   *  after the LLM turn to check output quality or trigger follow-ups. */
  evaluators?: PostTurnEvaluator[];
  /** v2 — Plugin-registered HTTP routes. The host serves these. */
  routes?: PluginRouteEntry[];
  /** Called when a plugin registers a new HTTP route. */
  onRouteRegistered?: (entry: PluginRouteEntry) => void;
  /** v2 — Shared event bus for inter-plugin communication. */
  eventBus?: PluginEventBus;
  /** v2 — OAuth coordinator. When present, plugins can register OAuth
   *  configs and the host will drive the auth flow. */
  oauthCoordinator?: OAuthCoordinator;
  /** v2 — Host base URL for building callback URLs, webhook endpoints, etc. */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// PluginApiImpl — concrete implementation given to each plugin
// ---------------------------------------------------------------------------

export class PluginApiImpl implements EthosPluginApi {
  readonly pluginId: string;

  private readonly registries: PluginRegistries;
  private readonly registeredTools: string[] = [];
  private readonly registeredInjectors: ContextInjector[] = [];
  private readonly registeredPersonalities: string[] = [];
  private readonly credentialStorage: CredentialStorage | null;
  private readonly credentialBasePath: string | null;
  private readonly credentialUpdateHandlers: Array<(key: string) => void | Promise<void>> = [];
  private readonly registeredFilters: ToolInvocationFilter[] = [];
  private readonly registeredEvaluators: PostTurnEvaluator[] = [];
  private readonly eventUnsubscribers: Array<() => void> = [];
  private oauthConfig?: OAuthConfig;

  constructor(
    pluginId: string,
    registries: PluginRegistries,
    credentialOpts?: { storage: CredentialStorage; basePath: string },
  ) {
    this.pluginId = pluginId;
    this.registries = registries;
    this.credentialStorage = credentialOpts?.storage ?? null;
    this.credentialBasePath = credentialOpts?.basePath ?? null;
  }

  registerTool(tool: Tool): void {
    // Tag the tool with this plugin's id so AgentLoop can gate it per personality.
    this.registries.tools.register(tool, { pluginId: this.pluginId });
    this.registeredTools.push(tool.name);
  }

  registerVoidHook<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
  ): void {
    this.registries.hooks.registerVoid(name, handler, { pluginId: this.pluginId });
  }

  registerModifyingHook<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
  ): void {
    this.registries.hooks.registerModifying(name, handler, { pluginId: this.pluginId });
  }

  registerInjector(injector: ContextInjector): void {
    this.registries.injectors.push(injector);
    this.registries.injectorPluginIds.set(injector, this.pluginId);
    this.registeredInjectors.push(injector);
  }

  registerPersonality(config: PersonalityConfig): void {
    this.registries.personalities.define(config);
    this.registeredPersonalities.push(config.id);
  }

  registerContextEngine(engine: ContextEngine): void {
    if (!this.registries.contextEngines) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerContextEngine but the host wiring did not expose a ContextEngineRegistry.`,
      );
    }
    this.registries.contextEngines.register(engine);
  }

  registerLLMProvider(name: string, factory: LLMProviderFactory): void {
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register LLM provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.llmProviders.register(qualifiedName, factory);
  }

  registerMemoryProvider(name: string, factory: MemoryProviderFactory): void {
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register memory provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.memoryProviders.register(qualifiedName, factory);
  }

  registerPlatformAdapter(name: string, factory: PlatformAdapterFactory): void {
    if (!this.registries.platformAdapters) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerPlatformAdapter but the host wiring did not expose an adapter registry.`,
      );
    }
    this.registries.platformAdapters.set(name, factory);
  }

  // ---- Credential methods ------------------------------------------------

  private credPath(key: string): string {
    return `${this.credentialBasePath}/credentials/${key}`;
  }

  hasSecret(key: string): boolean {
    if (!this.credentialStorage || !this.credentialBasePath) return false;
    return this.credentialStorage.existsSync(this.credPath(key));
  }

  async getSecret(key: string): Promise<string | null> {
    if (!this.credentialStorage || !this.credentialBasePath) return null;
    return this.credentialStorage.read(this.credPath(key));
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (!this.credentialStorage || !this.credentialBasePath) {
      throw new Error(`Plugin "${this.pluginId}" has no credential storage configured`);
    }
    const dir = `${this.credentialBasePath}/credentials`;
    await this.credentialStorage.mkdir(dir);
    await this.credentialStorage.writeAtomic(this.credPath(key), value);
    await this.credentialStorage.writeAtomic(
      `${this.credPath(key)}.meta`,
      JSON.stringify({ updatedAt: new Date().toISOString() }),
    );
    await this.fireCredentialUpdate(key);
  }

  onCredentialUpdate(handler: (key: string) => void | Promise<void>): () => void {
    this.credentialUpdateHandlers.push(handler);
    return () => {
      const idx = this.credentialUpdateHandlers.indexOf(handler);
      if (idx >= 0) this.credentialUpdateHandlers.splice(idx, 1);
    };
  }

  private async fireCredentialUpdate(key: string): Promise<void> {
    for (const handler of this.credentialUpdateHandlers) {
      await handler(key);
    }
  }

  // ---- v2 registration methods --------------------------------------------

  registerToolFilter(filter: ToolInvocationFilter): void {
    if (!this.registries.filters) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose a filters registry.`);
    }
    this.registries.filters.push(filter);
    this.registeredFilters.push(filter);
  }

  registerEvaluator(evaluator: PostTurnEvaluator): void {
    if (!this.registries.evaluators) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose an evaluators registry.`);
    }
    this.registries.evaluators.push(evaluator);
    this.registeredEvaluators.push(evaluator);
  }

  registerRoute(opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
  }): void {
    if (!this.registries.routes) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose a route registry.`);
    }
    if (!opts.path.startsWith('/')) {
      throw new Error(
        `Plugin "${this.pluginId}": route path must start with "/", got "${opts.path}"`,
      );
    }
    const entry: PluginRouteEntry = {
      pluginId: this.pluginId,
      method: opts.method ?? 'POST',
      path: opts.path,
      handler: opts.handler,
    };
    this.registries.routes.push(entry);
    this.registries.onRouteRegistered?.(entry);
  }

  emit(event: string, payload: unknown): void {
    this.registries.eventBus?.emit(event, payload);
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    const unsub = this.registries.eventBus?.on(event, handler) ?? (() => {});
    this.eventUnsubscribers.push(unsub);
    return unsub;
  }

  registerOAuth(config: OAuthConfig): void {
    this.oauthConfig = config;
  }

  getBaseUrl(): string | undefined {
    return this.registries.baseUrl;
  }

  /** Internal — used by AgentLoop for pre-turn credential check. */
  getOAuthConfig(): OAuthConfig | undefined {
    return this.oauthConfig;
  }

  /** Remove everything this plugin registered. Called by PluginLoader.unload(). */
  cleanup(): void {
    // Hooks — HookRegistry tracks by pluginId
    this.registries.hooks.unregisterPlugin(this.pluginId);

    // Tools — remove by name
    for (const name of this.registeredTools) {
      this.registries.tools.unregister(name);
    }

    // Injectors — remove from the shared mutable array + provenance map
    for (const inj of this.registeredInjectors) {
      const idx = this.registries.injectors.indexOf(inj);
      if (idx >= 0) this.registries.injectors.splice(idx, 1);
      this.registries.injectorPluginIds.delete(inj);
    }

    // Personalities — no unregister method; they stay (harmless)

    // Credential update handlers
    this.credentialUpdateHandlers.length = 0;

    // v2 — Filters
    for (const f of this.registeredFilters) {
      const idx = this.registries.filters?.indexOf(f) ?? -1;
      if (idx >= 0) this.registries.filters?.splice(idx, 1);
    }

    // v2 — Evaluators
    for (const e of this.registeredEvaluators) {
      const idx = this.registries.evaluators?.indexOf(e) ?? -1;
      if (idx >= 0) this.registries.evaluators?.splice(idx, 1);
    }

    // v2 — Routes
    if (this.registries.routes) {
      const keep = this.registries.routes.filter((r) => r.pluginId !== this.pluginId);
      this.registries.routes.length = 0;
      this.registries.routes.push(...keep);
    }

    // v2 — Event bus subscriptions
    for (const unsub of this.eventUnsubscribers) unsub();
    this.eventUnsubscribers.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Re-export commonly needed types for plugin authors
// ---------------------------------------------------------------------------

export type {
  ContextInjector,
  InjectionResult,
  LLMProviderFactory,
  LLMProviderFactoryContext,
  MemoryProviderFactory,
  MemoryProviderFactoryContext,
  ModifyingHooks,
  PersonalityConfig,
  PostTurnEvaluator,
  PostTurnEvaluatorPayload,
  PromptContext,
  Storage,
  Tool,
  ToolContext,
  ToolInvocationFilter,
  ToolResult,
  VoidHooks,
} from '@ethosagent/types';

export { ContextStore } from './context-registry';
