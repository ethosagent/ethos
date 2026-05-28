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
  /** Remove everything this plugin registered. Called by PluginLoader.unload(). */
  cleanup() {
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
  }
}
