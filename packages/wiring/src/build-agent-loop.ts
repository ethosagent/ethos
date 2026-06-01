import { join } from 'node:path';
import { AgentLoop, EagerPrefetchPolicy, SimpleCompletionImpl } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createMemoryTools } from '@ethosagent/tools-memory';
import { createVisionTools } from '@ethosagent/tools-vision';
import type { LLMProvider, MemoryProvider, RequestDumpStore } from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import type { ComposeToolsResult, GatewaySendRef } from './compose-tools';
import type {
  CreateAgentLoopOptions,
  CreateAgentLoopResult,
  WiringConfig,
  WiringProfile,
} from './index';
import type { LoadPluginsResult } from './load-plugins';
import type { WiringContext } from './types';

export interface BuildAgentLoopDeps {
  infra: InfrastructureResult;
  toolsResult: ComposeToolsResult;
  pluginsResult: LoadPluginsResult;
  llm: LLMProvider;
  profile: WiringProfile;
}

/**
 * Final assembly phase: resolve memory, wire vision tools, wire the improvement
 * fork and safety subsystems, construct AgentLoop, register delegation tools,
 * validate tool capabilities, and return the CreateAgentLoopResult.
 */
export async function buildAgentLoop(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
  deps: BuildAgentLoopDeps,
): Promise<CreateAgentLoopResult> {
  const { dataDir, log } = wiringCtx;
  const { infra, toolsResult, pluginsResult, llm, profile } = deps;
  const { memoryProviders, personalities, hooks, sessionCompose, tools } = infra;
  const { gatewaySendRef, injectors } = toolsResult;
  const {
    pluginLoader,
    pluginRegistries,
    pluginDiagnostics,
    injectorPluginIds,
    contextEngines,
    notificationRouter,
  } = pluginsResult;

  const NOOP_SECRETS = {
    get: async () => null as null,
    set: async () => {},
    delete: async () => {},
    list: async () => [] as string[],
  };

  // -------------------------------------------------------------------------
  // Wire llmFactory now that the LLM provider is resolved.
  // -------------------------------------------------------------------------

  pluginRegistries.llmFactory = () =>
    new SimpleCompletionImpl(llm, config.model, ({ input, output }) => {
      pluginDiagnostics.pushMetric({
        pluginId: 'framework',
        name: 'monitor_llm_usage',
        value: output,
        labels: { type: 'output_tokens', input_tokens: String(input) },
        timestamp: new Date().toISOString(),
      });
    });

  // -------------------------------------------------------------------------
  // Memory provider
  // -------------------------------------------------------------------------

  const session = sessionCompose.sessionStore;
  const memoryName = config.memory ?? 'markdown';
  const memoryFactory = memoryProviders.get(memoryName);
  if (!memoryFactory) {
    throw new Error(
      `Memory provider "${memoryName}" is not registered. ` +
        `Available: ${memoryProviders.list().join(', ')}`,
    );
  }
  const memory = new EagerPrefetchPolicy(
    await memoryFactory({
      config: {},
      dataDir,
      secrets: config.secretsResolver ?? NOOP_SECRETS,
      logger: log,
    }),
  );
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);

  // -------------------------------------------------------------------------
  // Vision tools (registered here because they need `llm`)
  // -------------------------------------------------------------------------

  const auxVisionConfig = config.auxiliaryVision;
  const auxVisionCollidesWithPrimary =
    auxVisionConfig !== undefined && auxVisionConfig.model === config.model;
  if (
    auxVisionConfig &&
    auxVisionCollidesWithPrimary &&
    (auxVisionConfig.provider !== undefined ||
      auxVisionConfig.apiKey !== undefined ||
      auxVisionConfig.baseUrl !== undefined)
  ) {
    log.warn(
      `auxiliary.vision.model ("${auxVisionConfig.model}") matches the primary model; ` +
        'auxiliary.vision.provider/apiKey/baseUrl overrides will be ignored. ' +
        'Either change the model id or drop the overrides.',
    );
  }
  let auxVisionProvider: LLMProvider | null = null;
  if (auxVisionConfig && !auxVisionCollidesWithPrimary) {
    const auxProviderName = auxVisionConfig.provider ?? config.provider;
    const auxFactory = infra.llmProviders.get(auxProviderName);
    if (auxFactory) {
      auxVisionProvider = await auxFactory({
        config: {
          provider: auxProviderName,
          model: auxVisionConfig.model,
          apiKey: auxVisionConfig.apiKey ?? config.apiKey,
          ...((auxVisionConfig.baseUrl ?? config.baseUrl)
            ? { baseUrl: auxVisionConfig.baseUrl ?? config.baseUrl }
            : {}),
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        },
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
    } else {
      log.warn(
        `auxiliary.vision provider "${auxProviderName}" not registered; ` +
          `vision_analyze won't use auxiliary model`,
      );
    }
  }
  for (const tool of createVisionTools({
    resolveProvider: (model) => {
      if (model === config.model) return llm;
      if (auxVisionProvider && auxVisionConfig && model === auxVisionConfig.model) {
        return auxVisionProvider;
      }
      return null;
    },
    defaultModel: config.model,
    ...(auxVisionConfig && !auxVisionCollidesWithPrimary
      ? { auxiliaryVisionModel: auxVisionConfig.model }
      : {}),
  })) {
    tools.register(tool);
  }

  // -------------------------------------------------------------------------
  // E3 — improvement fork
  // -------------------------------------------------------------------------

  let onSkillProposedFn: ((skillId: string, personalityId: string) => void) | undefined;
  let onSkillAppliedFn: ((skillId: string, personalityId: string) => void) | undefined;

  const { ImprovementFork, loadEvolveConfig: loadEvolveConfigFn } = await import(
    '@ethosagent/skill-evolver'
  );
  const evolveConfigPath = join(dataDir, 'evolve-config.json');
  const wiringStorage = new FsStorage();
  const improvementFork = new ImprovementFork({
    hooks,
    runtime: {
      llm,
      model: config.model,
      memoryProvider: memory,
      sessionStore: session,
    },
    personalities,
    dataDir,
    storage: wiringStorage,
    onSkillProposed: (skillId, personalityId) => {
      onSkillProposedFn?.(skillId, personalityId);
    },
    autoApprove: () => {
      return autoApproveCache;
    },
    onSkillApplied: (skillId, personalityId) => {
      onSkillAppliedFn?.(skillId, personalityId);
    },
  });
  improvementFork.register();

  let autoApproveCache = false;
  (async () => {
    try {
      const cfg = await loadEvolveConfigFn(evolveConfigPath, wiringStorage);
      autoApproveCache = cfg.autoApprove;
    } catch {
      // Non-fatal — keep the default.
    }
  })();

  hooks.registerVoid('agent_done', async () => {
    try {
      const cfg = await loadEvolveConfigFn(evolveConfigPath, wiringStorage);
      autoApproveCache = cfg.autoApprove;
    } catch {
      // Non-fatal.
    }
  });

  // -------------------------------------------------------------------------
  // Ch.6a — In-process watcher
  // -------------------------------------------------------------------------

  const { Watcher: WatcherClass, defaultRules: watcherDefaultRules } = await import(
    '@ethosagent/safety-watcher'
  );
  const watcher = new WatcherClass({
    rules: watcherDefaultRules(),
    ...(opts.observability ? { observability: opts.observability } : {}),
  });

  // -------------------------------------------------------------------------
  // Ch.3c Tier-2 — LLM injection classifier
  // -------------------------------------------------------------------------

  const { createLLMClassifier } = await import('@ethosagent/safety-injection');
  const injectionClassifier = createLLMClassifier({ llm });

  // -------------------------------------------------------------------------
  // P3 observability — request dump store
  // -------------------------------------------------------------------------

  let requestDumpStore: RequestDumpStore | undefined;
  if (config.observabilityRequestDump?.enabled) {
    const { JsonlRequestDumpStore } = await import('@ethosagent/request-dump');
    const dumpDir = config.observabilityRequestDump.dir ?? join(dataDir, 'request-dumps');
    requestDumpStore = new JsonlRequestDumpStore({
      dir: dumpDir,
      maxBytes: config.observabilityRequestDump.rotation?.maxBytes,
    });
  }

  // -------------------------------------------------------------------------
  // Memory provider map (AgentLoop shape)
  // -------------------------------------------------------------------------

  const memoryProviderMap = new Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >();
  for (const name of memoryProviders.list()) {
    const factory = memoryProviders.get(name);
    if (factory) {
      memoryProviderMap.set(name, (options) =>
        factory({
          config: options ?? {},
          dataDir,
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // AgentLoop construction
  // -------------------------------------------------------------------------

  const activePerson = infra.activePerson;
  const activeMcpPolicy = personalities.getMcpPolicy(activePerson.id);
  const workingDir = wiringCtx.workingDir;

  const loop = new AgentLoop({
    llm,
    tools,
    session,
    memory,
    personalities,
    injectors,
    injectorPluginIds,
    hooks,
    storage: new FsStorage(),
    dataDir,
    modelRouting: config.modelRouting,
    memoryProviders: memoryProviderMap,
    watcher,
    injectionClassifier,
    contextEngines,
    clarifyBridge: infra.clarifyBridge,
    ...(config.teamName ? { teamId: config.teamName } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(requestDumpStore ? { requestDumpStore } : {}),
    ...(activeMcpPolicy ? { mcpPolicy: activeMcpPolicy } : {}),
    onToolMetric: (metric) => {
      pluginDiagnostics.pushEvent({
        pluginId: metric.pluginId,
        level: 'info',
        message: 'tool_invocation',
        timestamp: new Date().toISOString(),
        data: {
          toolName: metric.toolName,
          ok: metric.ok,
          durationMs: metric.durationMs,
        },
        sessionId: metric.sessionId,
        turnId: metric.turnId,
      });
    },
    options: {
      platform: profile,
      workingDir,
    },
  });

  // Delegation tools need the loop reference; register after loop creation.
  for (const tool of createDelegationTools(loop, opts.meshRegistryPath)) tools.register(tool);

  // Phase tool-cap P1 — fail-loud-at-boot validation.
  const validationErrors = tools.validateToolsForPersonality(activePerson);
  if (validationErrors.length > 0) {
    const summary = validationErrors
      .map((e) => `  ${e.tool} [${e.capability}]: ${e.message}`)
      .join('\n');
    throw new Error(
      `Tool capability validation failed for personality "${activePerson.id}":\n${summary}\n` +
        `Adjust the personality's safety.network.allow / fs_reach, or remove the tool from toolset.yaml.`,
    );
  }

  const ref: GatewaySendRef = gatewaySendRef;

  return {
    loop,
    toolRegistry: tools,
    setMessagingSend: (fn) => {
      ref.fn = fn;
    },
    setOnSkillProposed: (fn) => {
      onSkillProposedFn = fn;
    },
    setOnSkillApplied: (fn) => {
      onSkillAppliedFn = fn;
    },
    notificationRouter,
    pluginLoader,
  };
}
