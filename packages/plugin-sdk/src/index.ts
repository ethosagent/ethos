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
  Tool,
  ToolRegistry,
  VoidHooks,
} from '@ethosagent/types';

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

  constructor(pluginId: string, registries: PluginRegistries) {
    this.pluginId = pluginId;
    this.registries = registries;
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
  PromptContext,
  Tool,
  ToolContext,
  ToolResult,
  VoidHooks,
} from '@ethosagent/types';
