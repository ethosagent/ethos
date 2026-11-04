import { DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import type { ContextInjector, ModifyingHooks, Tool, VoidHooks } from '@ethosagent/types';

/** Registrations the plugin makes, observed as they happen. */
export interface RegistrationObserver {
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
function unsupported<T extends object>(method: string): T {
  const refuse = (): never => {
    throw new Error(
      `${method} is not supported when a plugin runs in a plugin host. Set this plugin to in-process (plugins.isolation) to use it.`,
    );
  };
  return new Proxy({} as T, {
    get: () => refuse,
    has: () => true,
  });
}

export interface ChildRegistries {
  registries: PluginRegistries;
  tools: RecordingToolRegistry;
  hooks: RecordingHookRegistry;
}

export function createChildRegistries(observer: () => RegistrationObserver): ChildRegistries {
  const tools = new RecordingToolRegistry(observer);
  const hooks = new RecordingHookRegistry(observer);
  const injectors: ContextInjector[] = [];
  const registries: PluginRegistries = {
    tools,
    hooks,
    injectors,
    injectorPluginIds: new Map(),
    personalities: unsupported('registerPersonality'),
    contextEngines: unsupported('registerContextEngine'),
    llmProviders: unsupported('registerLLMProvider'),
    memoryProviders: unsupported('registerMemoryProvider'),
    storageBackends: unsupported('registerStorage'),
    executionBackends: unsupported('registerExecutionBackend'),
    platformAdapters: unsupported('registerPlatformAdapter'),
    sttProviders: unsupported('registerSttProvider'),
    ttsProviders: unsupported('registerTtsProvider'),
    oauthRegistry: unsupported('registerCustomOAuthFlow'),
  };
  return { registries, tools, hooks };
}
