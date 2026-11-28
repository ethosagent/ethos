// The world runtime: the one place that opens the world service store, resolves graph backends
// and builds WorldService + WorldSchemaService + WorldConfigService (plan world-model 4.6).
//
// Tools and the injector get a narrow view only: `toolPort()` is a frozen WorldToolPort
// (extensions/world-service/src/port.ts, pinned by world-port.test.ts 'R13 tool port is narrow')
// and `injector()` holds a `Pick<WorldService, 'visible' | 'query' | 'neighbours'>`. Neither ever
// holds a provider. Created exactly once, in packages/wiring/src/compose-tools.ts
// (`composeAllTools`), and closed by that stage's DisposerStack.

import { type EthosConfig, resolveWorld } from '@ethosagent/config';
import { estimateCost } from '@ethosagent/pricing';
import type {
  LLMProvider,
  Logger,
  SecretsResolver,
  Storage,
  WorldGraphProvider,
  WorldGraphProviderRegistry,
  WorldId,
} from '@ethosagent/types';
import {
  type BuildSourceDeps,
  type CompleteFn,
  createWorldToolPort,
  SQLiteWorldServiceStore,
  serviceDbPath,
  WorldBuildService,
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

/**
 * What the first build (`world_build`) needs from the host. Bound in compose-tools.ts, where the
 * session store, memory registry and aux provider live. `readFolder` is not here: it is the
 * calling turn's own fs reach, passed on every `port.build` call (tools-world bulk-tools.ts).
 */
export interface WorldBuildBindings {
  /** Memory (via the configured backend), the personality's own sessions and `turnWasShared`. */
  sources: Omit<BuildSourceDeps, 'readFolder'>;
  /** The auxiliary model, metered as `tool_llm` (`usageMeter.meter(llm, 'tool_llm')`); resolved on first use. */
  llm: () => Promise<LLMProvider>;
  /** The model name `llm` serves, for pricing the estimate and the budget stop. */
  model: string;
  /** `AgentSafety.injection.wrapUntrusted`. */
  wrapUntrusted: (input: { content: string; toolName: string; source?: string }) => {
    content: string;
  };
}

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
  /** Absent: `world_build` answers `not available` (nothing else changes). */
  build?: WorldBuildBindings;
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

/** One bare, metered `llm.complete` call: no AgentLoop.run, so nothing to drain (plan Global Constraints). */
function buildComplete(b: WorldBuildBindings): CompleteFn {
  return async ({ system, user }) => {
    const llm = await b.llm();
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of llm.complete([{ role: 'user', content: user }], [], {
      system,
      maxTokens: 2048,
      temperature: 0,
    })) {
      if (chunk.type === 'text_delta') text += chunk.text;
      else if (chunk.type === 'usage') {
        inputTokens = chunk.usage.inputTokens;
        outputTokens = chunk.usage.outputTokens;
      }
    }
    return { text, inputTokens, outputTokens };
  };
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
  const b = deps.build;
  const builder = b
    ? new WorldBuildService({
        service,
        store,
        schema,
        sources: b.sources,
        complete: buildComplete(b),
        wrap: (text, source) =>
          b.wrapUntrusted({ content: text, toolName: 'world_build', source }).content,
        price: (inputTokens, outputTokens) =>
          estimateCost(b.model, { inputTokens, outputTokens }).costUsd,
        onError,
      })
    : undefined;
  const toolPort = createWorldToolPort(service, builder);

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
