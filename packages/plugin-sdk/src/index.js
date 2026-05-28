import { PluginMonitorRunner } from './monitor-runner';
// ---------------------------------------------------------------------------
// PluginEventBus — lightweight pub/sub for inter-plugin communication
// ---------------------------------------------------------------------------
export class PluginEventBus {
  handlers = new Map();
  emit(event, payload) {
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
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    const set = this.handlers.get(event);
    if (set) set.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}
// ---------------------------------------------------------------------------
// PluginApiImpl — concrete implementation given to each plugin
// ---------------------------------------------------------------------------
export class PluginApiImpl {
  pluginId;
  registries;
  registeredTools = [];
  registeredInjectors = [];
  registeredPersonalities = [];
  credentialStorage;
  credentialBasePath;
  credentialUpdateHandlers = [];
  registeredFilters = [];
  registeredEvaluators = [];
  eventUnsubscribers = [];
  monitorRunner = new PluginMonitorRunner();
  healthChecks = [];
  registeredRendererTypes = [];
  oauthConfig;
  constructor(pluginId, registries, credentialOpts) {
    this.pluginId = pluginId;
    this.registries = registries;
    this.credentialStorage = credentialOpts?.storage ?? null;
    this.credentialBasePath = credentialOpts?.basePath ?? null;
  }
  registerTool(tool) {
    // Tag the tool with this plugin's id so AgentLoop can gate it per personality.
    this.registries.tools.register(tool, { pluginId: this.pluginId });
    this.registeredTools.push(tool.name);
  }
  registerVoidHook(name, handler) {
    this.registries.hooks.registerVoid(name, handler, { pluginId: this.pluginId });
  }
  registerModifyingHook(name, handler) {
    this.registries.hooks.registerModifying(name, handler, { pluginId: this.pluginId });
  }
  registerInjector(injector) {
    this.registries.injectors.push(injector);
    this.registries.injectorPluginIds.set(injector, this.pluginId);
    this.registeredInjectors.push(injector);
  }
  registerPersonality(config) {
    this.registries.personalities.define(config);
    this.registeredPersonalities.push(config.id);
  }
  registerContextEngine(engine) {
    if (!this.registries.contextEngines) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerContextEngine but the host wiring did not expose a ContextEngineRegistry.`,
      );
    }
    this.registries.contextEngines.register(engine);
  }
  registerLLMProvider(name, factory) {
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register LLM provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.llmProviders.register(qualifiedName, factory);
  }
  registerMemoryProvider(name, factory) {
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register memory provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.memoryProviders.register(qualifiedName, factory);
  }
  registerPlatformAdapter(name, factory) {
    if (!this.registries.platformAdapters) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerPlatformAdapter but the host wiring did not expose an adapter registry.`,
      );
    }
    this.registries.platformAdapters.set(name, factory);
  }
  // ---- Credential methods ------------------------------------------------
  credPath(key) {
    return `${this.credentialBasePath}/credentials/${key}`;
  }
  hasSecret(key) {
    if (!this.credentialStorage || !this.credentialBasePath) return false;
    return this.credentialStorage.existsSync(this.credPath(key));
  }
  async getSecret(key) {
    if (!this.credentialStorage || !this.credentialBasePath) return null;
    return this.credentialStorage.read(this.credPath(key));
  }
  async setSecret(key, value) {
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
  onCredentialUpdate(handler) {
    this.credentialUpdateHandlers.push(handler);
    return () => {
      const idx = this.credentialUpdateHandlers.indexOf(handler);
      if (idx >= 0) this.credentialUpdateHandlers.splice(idx, 1);
    };
  }
  async fireCredentialUpdate(key) {
    for (const handler of this.credentialUpdateHandlers) {
      await handler(key);
    }
  }
  // ---- v2 registration methods --------------------------------------------
  registerToolFilter(filter) {
    if (!this.registries.filters) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose a filters registry.`);
    }
    this.registries.filters.push(filter);
    this.registeredFilters.push(filter);
  }
  registerEvaluator(evaluator) {
    if (!this.registries.evaluators) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose an evaluators registry.`);
    }
    this.registries.evaluators.push(evaluator);
    this.registeredEvaluators.push(evaluator);
  }
  registerRoute(opts) {
    if (!this.registries.routes) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose a route registry.`);
    }
    if (!opts.path.startsWith('/')) {
      throw new Error(
        `Plugin "${this.pluginId}": route path must start with "/", got "${opts.path}"`,
      );
    }
    const entry = {
      pluginId: this.pluginId,
      method: opts.method ?? 'POST',
      path: opts.path,
      handler: opts.handler,
    };
    this.registries.routes.push(entry);
    this.registries.onRouteRegistered?.(entry);
  }
  emit(event, payload) {
    this.registries.eventBus?.emit(event, payload);
  }
  on(event, handler) {
    const unsub = this.registries.eventBus?.on(event, handler) ?? (() => {});
    this.eventUnsubscribers.push(unsub);
    return unsub;
  }
  registerOAuth(config) {
    this.oauthConfig = config;
  }
  getBaseUrl() {
    return this.registries.baseUrl;
  }
  // ---- v2.2 monitor + notification methods --------------------------------
  registerMonitor(def) {
    this.monitorRunner.registerDef(def);
  }
  startMonitor(name, params) {
    const store = new Map();
    this.diagnostics.info(
      'Monitor started with ephemeral kvStore — data will not persist across restarts',
      { monitorName: name },
    );
    const llm = this.registries.llmFactory?.();
    this.monitorRunner.start(name, params ?? {}, {
      pluginId: this.pluginId,
      notify: (opts) => this.notify(opts),
      getSecret: (key) => this.getSecret(key),
      kvStore: {
        get: async (k) => store.get(k) ?? null,
        set: async (k, v) => {
          store.set(k, v);
        },
        delete: async (k) => {
          store.delete(k);
        },
        list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
      },
      emit: (event, payload) => this.emit(event, payload),
      diagnostics: this.diagnostics,
      llm,
    });
  }
  stopMonitor(name) {
    this.monitorRunner.stop(name);
  }
  async notify(opts) {
    if (!this.registries.notificationRouter) {
      this.diagnostics.warn(
        'notify() called but no NotificationRouter is configured — message dropped',
        { sessionKey: opts.sessionKey },
      );
      return;
    }
    await this.registries.notificationRouter.route(this.pluginId, opts);
  }
  // ---- v2.2 diagnostics methods --------------------------------------------
  diagnostics = {
    debug: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'debug',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    info: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'info',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    warn: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'warn',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    error: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'error',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    metric: (name, value, labels) => {
      this.registries.diagnostics?.pushMetric({
        pluginId: this.pluginId,
        name,
        value,
        labels,
        timestamp: new Date().toISOString(),
      });
    },
  };
  registerHealthCheck(check) {
    this.healthChecks.push(check);
  }
  registerPluginPage(spec) {
    if (!this.registries.pluginPages) {
      this.registries.pluginPages = new Map();
    }
    this.registries.pluginPages.set(this.pluginId, spec);
  }
  registerRenderer(spec) {
    if (!this.registries.renderers) {
      this.registries.renderers = new Map();
    }
    const existing = this.registries.renderers.get(spec.type);
    if (existing && !this.registeredRendererTypes.includes(spec.type)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register renderer type "${spec.type}": already registered by another plugin.`,
      );
    }
    this.registries.renderers.set(spec.type, spec);
    if (!this.registeredRendererTypes.includes(spec.type)) {
      this.registeredRendererTypes.push(spec.type);
    }
  }
  getHealthChecks() {
    return this.healthChecks;
  }
  /** v2.2 — Return names of monitors that have crashed. */
  getCrashedMonitors() {
    return this.monitorRunner.getCrashedMonitors();
  }
  /** Internal — used by AgentLoop for pre-turn credential check. */
  getOAuthConfig() {
    return this.oauthConfig;
  }
  /** Remove everything this plugin registered. Called by PluginLoader.unload(). */
  cleanup() {
    // Monitors
    this.monitorRunner.stopAll();
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
    // OAuth
    this.registries.oauthCoordinator?.cancelAll(this.pluginId);
    // Diagnostics
    this.registries.diagnostics?.clearPlugin(this.pluginId);
    this.healthChecks.length = 0;
    // v2.3 — Plugin pages
    this.registries.pluginPages?.delete(this.pluginId);
    // v2.3 — Renderers
    for (const type of this.registeredRendererTypes) {
      this.registries.renderers?.delete(type);
    }
    this.registeredRendererTypes.length = 0;
  }
}
export { ContextStore } from './context-registry';
export { DiagnosticStore } from './diagnostic-store';
export { OAuthCoordinatorImpl } from './oauth-coordinator';
