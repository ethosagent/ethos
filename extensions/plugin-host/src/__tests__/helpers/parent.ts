import { join } from 'node:path';
import { DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import {
  DiagnosticStore,
  type EthosPlugin,
  PluginApiImpl,
  PluginEventBus,
  type PluginRegistries,
  type PluginRouteEntry,
} from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ContextInjector,
  DocumentExtractor,
  NotifyOptions,
  PersonalityConfig,
  PluginHealthCheck,
  PostTurnEvaluator,
  SecretsResolver,
  ToolInvocationFilter,
} from '@ethosagent/types';
import { createPluginActivator } from '../../activator';
import { fixtureDir, type Harness } from './harness';

/** A SecretsResolver over a map; the parent's own vault for these tests. */
export function memorySecrets(initial: Record<string, string> = {}): SecretsResolver & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(ref) {
      return values.get(ref) ?? null;
    },
    async set(ref, value) {
      values.set(ref, value);
    },
    async delete(ref) {
      values.delete(ref);
    },
    async list(prefix) {
      return [...values.keys()].filter((k) => prefix === undefined || k.startsWith(prefix));
    },
  };
}

/** A parent with every registry the replay writes to, each observable. */
export interface ParentFixture {
  api: PluginApiImpl;
  registries: PluginRegistries;
  tools: DefaultToolRegistry;
  hooks: DefaultHookRegistry;
  injectors: ContextInjector[];
  filters: ToolInvocationFilter[];
  evaluators: PostTurnEvaluator[];
  routes: PluginRouteEntry[];
  personalities: PersonalityConfig[];
  profiles: unknown[];
  extractors: DocumentExtractor[];
  notified: Array<{ pluginId: string; opts: NotifyOptions }>;
  busLog: Array<[string, unknown]>;
  bus: PluginEventBus;
  diagnostics: DiagnosticStore;
  secrets: ReturnType<typeof memorySecrets>;
  plugin: EthosPlugin;
  healthChecks(): PluginHealthCheck[];
}

export interface ParentOptions {
  secrets?: Record<string, string>;
  baseUrl?: string;
  /** Replaces the activator's secret refs sent at spawn (key NAMES, D19). */
  secretKeys?: string[];
}

export async function activateInParent(
  h: Harness,
  id: string,
  fixture: string,
  opts: ParentOptions = {},
): Promise<ParentFixture> {
  const secrets = memorySecrets(opts.secrets);
  const tools = new DefaultToolRegistry();
  const hooks = new DefaultHookRegistry();
  const injectors: ContextInjector[] = [];
  const filters: ToolInvocationFilter[] = [];
  const evaluators: PostTurnEvaluator[] = [];
  const routes: PluginRouteEntry[] = [];
  const personalities: PersonalityConfig[] = [];
  const profiles: unknown[] = [];
  const extractors: DocumentExtractor[] = [];
  const notified: ParentFixture['notified'] = [];
  const busLog: ParentFixture['busLog'] = [];
  const bus = new PluginEventBus();
  const diagnostics = new DiagnosticStore();
  const registries: PluginRegistries = {
    tools,
    hooks,
    injectors,
    injectorPluginIds: new Map(),
    filters,
    evaluators,
    routes,
    eventBus: bus,
    diagnostics,
    personalities: {
      define: (c: PersonalityConfig) => void personalities.push(c),
    } as never,
    oauthRegistry: {
      registerProfile: (p: unknown) => void profiles.push(p),
      registerCustomFlow: () => undefined,
    },
    documentExtractors: {
      register: (e: DocumentExtractor) => void extractors.push(e),
      for: () => undefined,
      list: () => [],
    },
    notificationRouter: {
      route: async (pluginId, opts) => void notified.push({ pluginId, opts }),
      register: () => undefined,
      deregister: () => undefined,
    },
    llmProviders: {} as never,
    memoryProviders: {} as never,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  };
  for (const event of ['mon.event', 'mon.llm', 'mon.kv', 'rows.event', 'bad.event', 'x.out']) {
    bus.on(event, (payload) => busLog.push([event, payload]));
  }
  const api = new PluginApiImpl(id, registries, {
    secrets,
    storage: new FsStorage(),
    basePath: join(h.dataDir, 'plugins', id),
  });
  const activator = createPluginActivator(h.pool, {
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    secretKeys: () =>
      opts.secretKeys ??
      [...secrets.values.keys()]
        .filter((r) => r.startsWith(`plugins/${id}/`))
        .map((r) => r.slice(`plugins/${id}/`.length)),
  });
  const plugin = await activator.activate({
    id,
    dir: fixtureDir(fixture),
    entry: '',
    manifest: {},
    tier: 'untrusted',
  });
  await plugin.activate(api);
  return {
    api,
    registries,
    tools,
    hooks,
    injectors,
    filters,
    evaluators,
    routes,
    personalities,
    profiles,
    extractors,
    notified,
    busLog,
    bus,
    diagnostics,
    secrets,
    plugin,
    healthChecks: () => api.getHealthChecks(),
  };
}
