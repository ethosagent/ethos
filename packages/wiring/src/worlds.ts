// The world runtime: the one place that opens the world service store, resolves graph backends
// and builds WorldService + WorldSchemaService + WorldConfigService (plan world-model 4.6).
//
// Tools and the injector get a narrow view only: `toolPort()` is a frozen WorldToolPort
// (extensions/world-service/src/port.ts, pinned by world-port.test.ts 'R13 tool port is narrow')
// and `injector()` holds a `Pick<WorldService, 'visible' | 'query' | 'neighbours'>`. Neither ever
// holds a provider. Created exactly once, in packages/wiring/src/compose-tools.ts
// (`composeAllTools`), and closed by that stage's DisposerStack.

import { type EthosConfig, resolveWorld } from '@ethosagent/config';
import type {
  Logger,
  SecretsResolver,
  Storage,
  WorldGraphProvider,
  WorldGraphProviderRegistry,
  WorldId,
} from '@ethosagent/types';
import {
  createWorldToolPort,
  SQLiteWorldServiceStore,
  serviceDbPath,
  WorldConfigService,
  WorldContextInjector,
  WorldSchemaService,
  WorldService,
  type WorldToolPort,
  worldSlug,
} from '@ethosagent/world-service';
import { resolveWorldProvider } from './world-providers';

/** The backend every private world uses, and the default for a `world.yaml` without `backend`. */
const DEFAULT_BACKEND = 'sqlite';

export interface WorldRuntimeDeps {
  dataDir: string;
  /** Compose-time Storage: the only way schema.yaml / world.yaml / worlds.yaml are written. */
  storage: Storage;
  config: EthosConfig['world'];
  providers: WorldGraphProviderRegistry;
  secrets: SecretsResolver;
  logger: Logger;
  /** `AgentSafety.injection.sanitize` (S6). */
  sanitize: (s: string) => string;
}

export interface WorldRuntime {
  service: WorldService;
  schema: WorldSchemaService;
  configService: WorldConfigService;
  toolPort(): WorldToolPort;
  injector(): WorldContextInjector;
  close(): void;
}

/** A provider that owns a handle (the SQLite backend) exposes `dispose()`; the contract does not. */
function disposeOf(p: WorldGraphProvider): (() => void) | undefined {
  if ('dispose' in p && typeof p.dispose === 'function') {
    const dispose = p.dispose;
    return () => dispose.call(p);
  }
  return undefined;
}

export function createWorldRuntime(deps: WorldRuntimeDeps): WorldRuntime {
  const settings = resolveWorld({ world: deps.config });
  const onError = (e: unknown) =>
    deps.logger.warn(`world: ${e instanceof Error ? e.message : String(e)}`);

  const store = new SQLiteWorldServiceStore(serviceDbPath(deps.dataDir), {
    onError,
    cap: settings.proposals.cap,
    ttlDays: settings.proposals.ttlDays,
  });
  const configService = new WorldConfigService({ storage: deps.storage, dataDir: deps.dataDir });

  // One provider instance per backend name, opened on first use and shared by every world on it.
  const cache = new Map<string, Promise<WorldGraphProvider>>();
  const opened: WorldGraphProvider[] = [];
  const backendOf = async (world: WorldId): Promise<string> => {
    if (world.startsWith('personality:')) return DEFAULT_BACKEND;
    return (await configService.readWorld(worldSlug(world)))?.backend ?? DEFAULT_BACKEND;
  };
  const providerFor = async (world: WorldId): Promise<WorldGraphProvider> => {
    const name = await backendOf(world);
    let pending = cache.get(name);
    if (!pending) {
      const factory = resolveWorldProvider(deps.providers, name);
      pending = Promise.resolve(
        factory({
          config: {},
          dataDir: deps.dataDir,
          secrets: deps.secrets,
          logger: deps.logger,
        }),
      ).then((p) => {
        opened.push(p);
        return p;
      });
      cache.set(name, pending);
      // A failed open must not be cached: the next call retries.
      pending.catch(() => cache.delete(name));
    }
    return pending;
  };

  const schema = new WorldSchemaService({
    storage: deps.storage,
    dataDir: deps.dataDir,
    store,
    provider: providerFor,
  });
  const service = new WorldService({
    providers: providerFor,
    schema,
    store,
    config: configService,
    onError,
  });
  const toolPort = createWorldToolPort(service);

  return {
    service,
    schema,
    configService,
    toolPort: () => toolPort,
    injector: () =>
      new WorldContextInjector({
        service,
        sanitize: deps.sanitize,
        maxChars: settings.contextMaxChars,
        hops: settings.contextHops,
        onError,
      }),
    close() {
      for (const p of opened.splice(0)) {
        try {
          disposeOf(p)?.();
        } catch (e) {
          onError(e);
        }
      }
      cache.clear();
      store.dispose();
    },
  };
}
