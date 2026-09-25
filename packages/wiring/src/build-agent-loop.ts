import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { FsContentStore } from '@ethosagent/cas-fs';
import { backgroundDefaults, resolveDecisionsConfig } from '@ethosagent/config';
import {
  AgentLoop,
  ApproverDecisionSinks,
  type ClarifyOriginLane,
  DefaultJobRunnerRegistry,
  deriveFsReachPaths,
  EagerPrefetchPolicy,
  parseSmallWindowToolset,
  resolvePinned,
  resolveSttProvider,
  SimpleCompletionImpl,
} from '@ethosagent/core';
import { registerBuiltinExtractors } from '@ethosagent/document-extractors';
import { createRouterGate as createAcpRouterGate } from '@ethosagent/execution-coding-agents';
import { createRouterGate, PI_RUNNER_NAME, PiJobRunner } from '@ethosagent/execution-pi';
import { GoalRunner } from '@ethosagent/goal-runner';
import { BackgroundExecutor, ETHOS_RUNNER_NAME, EthosJobRunner } from '@ethosagent/job-runner';
import { SQLiteJobStore } from '@ethosagent/job-store';
import { PendingMemoryStore, TombstoneStore } from '@ethosagent/memory-approval';
import {
  type ConsolidateFn,
  MemoryCaptureRunner,
  type ProposeFn,
} from '@ethosagent/memory-capture';
import { withHistory } from '@ethosagent/memory-history';
import { buildConsolidationUpdates, consolidateMemory } from '@ethosagent/nightly-loop';
import type { Speaker, TranscriptEntry } from '@ethosagent/platform-callcapture';
import { MicCapture, TapCapture } from '@ethosagent/platform-callcapture';
import { sanitize } from '@ethosagent/safety-injection';
import { defaultAlwaysDeny, FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import { type CallCaptureToolsOptions, runCallCapture } from '@ethosagent/tools-callcapture';
import {
  type BackgroundToolDeps,
  createDelegationTools,
  MeshProxyReconciler,
} from '@ethosagent/tools-delegation';
import { createMemoryTools } from '@ethosagent/tools-memory';
import { createVisionTools } from '@ethosagent/tools-vision';
import { createAgentConsultTool } from '@ethosagent/tools-voice';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  BackgroundJob,
  ClarifySurfaceType,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  PersonalityConfig,
  RequestDumpStore,
  SessionStore,
} from '@ethosagent/types';
import {
  createClarifyEscalator,
  createSecretHandler,
  InteractionRouter,
  SECRET_KIND,
} from '@ethosagent/worker-router';
import type { InfrastructureResult } from './build-infrastructure';
import type { ComposeToolsResult, GatewaySendRef } from './compose-tools';
import { buildCredentialCheck } from './credential-check';
import type { DisposerStack } from './disposer-stack';
import type {
  CreateAgentLoopOptions,
  CreateAgentLoopResult,
  WiringConfig,
  WiringProfile,
} from './index';
import { freezeLatestUserTurnCase, learningSubmitPort } from './learning-pipeline';
import type { LoadPluginsResult } from './load-plugins';
import { detectLocalRuntime } from './local-models';
import { approvalLimits, createMemoryBundle, createUndecoratedBackend } from './memory-backend';
import {
  lookupLegacyCatalogModelId,
  lookupProfile,
  mergeModelProfile,
  resolveCompactionGate,
  resolveDefaultContextEngine,
  resolveSmallWindowMode,
  scaleHistoryLimit,
} from './model-catalog';
import { projectContextFor, resolveTurnWorkdir } from './project-context-floor';
import { registerAcpJobRunners } from './register-acp-job-runners';
import { createSmallWindowResolver } from './small-window-resolver';
import {
  createToolLoadingResolver,
  evaluateContextFit,
  evaluateToolPayloadGuard,
  evaluateToolSchemaBudget,
  measureStaticFloor,
  RESULT_BUDGET_CEILING_CHARS,
  resolveResultBudgetGate,
  smallWindowModeMessage,
} from './static-floor';
import type { WiringContext } from './types';
import { buildVoiceStack } from './voice-stack';

/**
 * The approver's private decision-sink channel (plan decision-provider-personality
 * §15.3; `ApproverDecisionSinks`, @ethosagent/core). ONE per process, not per
 * build, because an approval surface is not always paired with the build whose
 * loop runs the turn: the gateway hands every bot loop's predicate the SYSTEM
 * build's `approverDecision` (apps/ethos/src/commands/gateway.ts, boot.ts), so a
 * per-build channel would leave bot turns without approver rows. Entries are keyed
 * by session + tool call and live only for one `before_tool_call` fire. Injected
 * into every loop and every `approverDecision` this module builds; not exported
 * from the package, so nothing but this composition root holds it.
 */
const APPROVER_DECISION_SINKS = new ApproverDecisionSinks();

export interface BuildAgentLoopDeps {
  infra: InfrastructureResult;
  toolsResult: ComposeToolsResult;
  pluginsResult: LoadPluginsResult;
  llm: LLMProvider;
  profile: WiringProfile;
  /** The stack every earlier stage registered on; this stage adds its own
   *  resources and hands `dispose` back on the result (F06). */
  disposers: DisposerStack;
}

/**
 * Call-capture's registration gate (plan/phases/call-capture-extension.md —
 * macOS-only, opt-in via `callCapture.personalityId`). Extracted as a pure
 * function so the gate itself is unit-testable without invoking the full
 * `buildAgentLoop` composition root (which opens SQLite stores, constructs an
 * LLM provider, loads plugins, and reads `~/.ethos/` — impractical to
 * construct in a focused test, per the same rationale
 * `safety-conformance-wiring.test.ts` documents for `buildAgentLoop`).
 */
export function isCallCaptureToolsEnabled(
  platform: NodeJS.Platform,
  config: Pick<WiringConfig, 'callCapture'>,
): boolean {
  return platform === 'darwin' && Boolean(config.callCapture?.personalityId);
}

/**
 * Resolve the Documents-tab mirror target for one call-capture invocation
 * (plan/phases/call-capture-desktop-ux.md, P4). Only personalities that
 * DECLARE `fs_reach.workdir` get a mirror target — `deriveFsReachPaths`
 * itself falls back to `cwd` when undeclared (so a personality's file tools
 * still get a workdir), but applying that same fallback here would silently
 * mirror call-capture transcripts into the process's cwd for every
 * personality with no declared workdir. Checking `fs_reach?.workdir` first
 * mirrors the same guard `personalityAssetDir` (`@ethosagent/core`) uses for
 * the same reason.
 *
 * Extracted as a pure function for the same testability reason
 * `isCallCaptureToolsEnabled` above is — `buildAgentLoop` is a full
 * composition root, impractical to construct in a focused test.
 */
export function resolveCallCaptureDocumentsWorkdir(
  personality: import('@ethosagent/types').PersonalityConfig | undefined,
  vars: Parameters<typeof deriveFsReachPaths>[1],
): string | undefined {
  return personality?.fs_reach?.workdir ? deriveFsReachPaths(personality, vars).workdir : undefined;
}

// Every channel adapter that sets `InboundMessage.platform` (and therefore
// `BackgroundJob.originPlatform`, copied from it at spawn) with a live clarify
// surface. `BackgroundJob.originPlatform` is a plain string — other origins
// (email, mcp, webhook, cron) carry values with no clarify surface at all.
const CLARIFY_SURFACE_TYPES = new Set<ClarifySurfaceType>([
  'tui',
  'cli',
  'web',
  'telegram',
  'slack',
  'discord',
  'whatsapp',
]);

function isClarifySurfaceType(platform: string): platform is ClarifySurfaceType {
  return CLARIFY_SURFACE_TYPES.has(platform as ClarifySurfaceType);
}

/**
 * D7/G2/G3 (plan/phases/pi-delegation.md §5/§6) — maps a background job's
 * recorded origin (the Phase-B lane-resolution columns on `BackgroundJob`) to
 * the `ClarifyOriginLane` `ClarifyBridge.setOriginResolver` expects. `null`
 * when the job has no recorded origin platform, or that platform has no
 * clarify surface — the bridge's `resolveRouting()` then falls back to the
 * request's own `surfaceType` (today's behaviour). `surfaceContext` reuses
 * the same `chatId`/`botKey`/`threadId` keys the per-platform
 * `clarify-surface.ts` files (Telegram/Slack/Discord/WhatsApp) write onto a
 * presented row's `surfaceContext`.
 *
 * Extracted as a pure function for the same testability reason
 * `isCallCaptureToolsEnabled` above is — `buildAgentLoop` is a full
 * composition root, impractical to construct in a focused test.
 */
export function resolveJobClarifyOrigin(
  job: Pick<
    BackgroundJob,
    'originPlatform' | 'originBotKey' | 'originChatId' | 'originThreadId'
  > | null,
): ClarifyOriginLane | null {
  const platform = job?.originPlatform;
  if (!platform || !isClarifySurfaceType(platform)) return null;
  return {
    surfaceType: platform,
    surfaceContext: {
      ...(job?.originChatId ? { chatId: job.originChatId } : {}),
      ...(job?.originBotKey ? { botKey: job.originBotKey } : {}),
      ...(job?.originThreadId ? { threadId: job.originThreadId } : {}),
    },
  };
}

/**
 * `MemoryProvider` (five methods, drift-gated) has no close; a backend that
 * holds a connection of its own — memory-vector's memory.db — exposes one.
 */
async function closeMemoryProvider(provider: MemoryProvider): Promise<void> {
  const close = (provider as Partial<{ close: () => unknown }>).close;
  if (typeof close === 'function') await close.call(provider);
}

/**
 * L-T3 — the replay arm's memory: reads pass through, `sync` does nothing.
 *
 * A replay is a measurement: it must not record what it said. The backends
 * write through `WiringContext.storage`, which under replay IS the overlay, so
 * the alternative to a no-op is a `BoundaryError` — a `memory_write` coming
 * back as a tool failure the model then reasons about, which changes the very
 * behaviour the arm is measuring. A no-op `sync` is the honest shape: memory is
 * READ exactly as the live agent reads it, and nothing is written.
 *
 * Local to this module rather than exported: it is not a reusable policy, it is
 * one arm of `CreateAgentLoopOptions.replay`.
 */
function readOnlyMemory(base: MemoryProvider): MemoryProvider {
  return {
    prefetch: (ctx) => base.prefetch(ctx),
    read: (key, ctx) => base.read(key, ctx),
    search: (query, ctx, opts) => base.search(query, ctx, opts),
    list: (ctx, opts) => base.list(ctx, opts),
    sync: async () => {},
  };
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
  const { infra, toolsResult, pluginsResult, llm, profile, disposers } = deps;
  const { memoryProviders, personalities, hooks, sessionCompose, tools } = infra;
  const { gatewaySendRef, goalStore, goalRunnerRef, injectors, mcpManager, skillsInjector } =
    toolsResult;
  const {
    pluginLoader,
    pluginRegistries,
    pluginDiagnostics,
    injectorPluginIds,
    contextEngines,
    notificationRouter,
    llmHandle,
    documentExtractors,
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

  // L-T3 — a replay arm runs on the injected in-memory store, so a measured
  // turn never lands in `sessions.db` (`CreateAgentLoopOptions.replay`). The
  // three sqlite connections are still OPEN (assembly opens them); nothing in
  // the loop reads or writes through them under replay.
  const session: SessionStore = opts.replay ? opts.replay.session : sessionCompose.sessionStore;
  // Model-visible ⟺ logged (plan/phases/model-visible-logged.md, Phase B).
  // `contextLog` shares `sessions.db` with `session` (D5); `contentStore` is
  // the content-addressed blob store the log's Tier A/B events reference.
  // Both are left OFF a replay arm. Not only hygiene — it is REQUIRED: the log
  // resolves the turn's message BY ID out of `sessions.db`
  // (`SQLiteContextLog.resolveAt`), and a replay's messages live in the
  // injected in-memory store, so the lookup throws and the turn dies. Wanting
  // it off is the same answer arrived at twice: a measurement has no business
  // writing sessions.db rows or CAS blobs the operator will later read as
  // history. `stages/context-emit.ts` is a no-op unless BOTH are set.
  const contextLog = sessionCompose.contextLog;
  const contentStore = new FsContentStore(join(dataDir, 'cas'), new FsStorage());
  const memoryName = config.memory ?? 'markdown';
  const memoryFactory = memoryProviders.get(memoryName);
  if (!memoryFactory) {
    throw new Error(
      `Memory provider "${memoryName}" is not registered. ` +
        `Available: ${memoryProviders.list().join(', ')}`,
    );
  }
  const baseMemory = await memoryFactory({
    config: {},
    dataDir,
    secrets: config.secretsResolver ?? NOOP_SECRETS,
    logger: log,
  });
  disposers.push('memory provider', () => closeMemoryProvider(baseMemory));
  // L-T3 — under replay the provider is read-only: `sync` becomes a no-op, so
  // nothing a measurement says is recorded, and the write does not trip the
  // overlay's refusal (the markdown backend writes through
  // `WiringContext.storage`, which IS the overlay here).
  //
  // Defence in depth, honestly labelled: the only caller of this handle's
  // `sync` is the `memory_write` tool (`extensions/tools-memory/src/index.ts`),
  // and under `RunOptions.dryRun` no tool executes at all — so a replay as
  // L-T4 runs it never reaches here. The wrapper is what keeps that true if a
  // later turn-end flush, or an arm run without `dryRun`, does. Pinned by
  // "a memory_write that does run writes nothing and does not fail" in
  // `__tests__/replay-isolation.test.ts`.
  const memory = new EagerPrefetchPolicy(opts.replay ? readOnlyMemory(baseMemory) : baseMemory);
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);
  // F04 — the host-side memory surfaces (web/desktop editor, Timeline, restore,
  // approve queue), selected from the SAME `config` + storage the registry
  // factory above resolved, so an editor write lands in the backend the agent
  // reads. Pinned by packages/wiring/src/__tests__/memory-bundle-loop.test.ts.
  const memoryBundle = createMemoryBundle({
    config,
    dataDir,
    storage: wiringCtx.storage,
    logger: log,
  });

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
  // Web tools (registered here because web_extract summarization needs `llm`)
  // -------------------------------------------------------------------------
  const auxWebConfig = config.auxiliaryWeb;
  let auxWebProvider: LLMProvider | null = null;
  if (auxWebConfig && auxWebConfig.model !== config.model) {
    const auxProviderName = auxWebConfig.provider ?? config.provider;
    const auxFactory = infra.llmProviders.get(auxProviderName);
    if (auxFactory) {
      auxWebProvider = await auxFactory({
        config: {
          provider: auxProviderName,
          model: auxWebConfig.model,
          apiKey: auxWebConfig.apiKey ?? config.apiKey,
          ...((auxWebConfig.baseUrl ?? config.baseUrl)
            ? { baseUrl: auxWebConfig.baseUrl ?? config.baseUrl }
            : {}),
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        },
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
    } else {
      log.warn(
        `auxiliary.web provider "${auxProviderName}" not registered; web_extract won't summarize`,
      );
    }
  }
  for (const tool of createWebTools({
    ...(config.webSearchBackend ? { searchBackend: config.webSearchBackend } : {}),
    ...(config.searxngUrl ? { searxngUrl: config.searxngUrl } : {}),
    // Personality tools.yaml is the source of truth; config.toolSettings is
    // the global fallback layer. The tool resolves both by ctx.personalityId.
    resolvePersonalitySetting: (personalityId) =>
      personalities.getToolsConfig(personalityId)?.web_search,
    ...(config.toolSettings ? { toolSettings: config.toolSettings } : {}),
    ...(auxWebConfig ? { auxModel: auxWebConfig.model } : {}),
    resolveProvider: (model) => {
      if (model === config.model) return llm;
      if (auxWebProvider && auxWebConfig && model === auxWebConfig.model) return auxWebProvider;
      return null;
    },
  })) {
    tools.register(tool);
  }

  // -------------------------------------------------------------------------
  // Call-capture (built here, not registered as a tool, because it needs
  // `llm` and `memory` — the same reason the vision and web tools above
  // construct here rather than in compose-tools.ts). macOS-only per
  // plan/phases/call-capture-extension.md — a complete no-op (no
  // construction, no behavior change) for every deployment that hasn't set
  // `callCapture.personalityId`. `runCallCapture` is never registered as a
  // `Tool` — it is not LLM-reachable from any chat turn; the only caller is
  // `CallCaptureDaemon`'s accept-gated `runCapture`, bound below into
  // `runCallCaptureFn` and threaded out through `CreateAgentLoopResult`
  // (see `apps/ethos/src/commands/serve.ts`). Decision 7 of the plan requires
  // an LLM content-summarization step over the finished transcript (not the
  // plain participant/line-count roll-up `buildTranscriptArtifact` produces
  // on its own), so `getSummaryProvider` is wired here rather than left
  // absent — leaving it absent would silently downgrade every capture to the
  // plain roll-up.
  // -------------------------------------------------------------------------

  let runCallCaptureFn:
    | ((
        personalityId: string,
        opts: {
          source?: string;
          abortSignal: AbortSignal;
          onEntry?: (entry: TranscriptEntry) => void;
          onAudioLevel?: (speaker: Speaker, level: number, at: number) => void;
        },
      ) => Promise<import('@ethosagent/tools-callcapture').CallCaptureResult>)
    | undefined;
  if (isCallCaptureToolsEnabled(process.platform, config)) {
    const sttResolution = await resolveSttProvider({
      registry: infra.sttProviders,
      providerName: config.auxiliaryAsr?.provider,
      providerConfig: { ...config.auxiliaryAsr },
    });
    if (!sttResolution.ok) {
      log.warn(
        `call-capture: STT unavailable (${sttResolution.error}) — call capture will report itself unavailable`,
      );
    }
    // When `wiringCtx.callCaptureNativeDir` is set (bundled callers only —
    // see `types.ts`), override each binary's default `import.meta.dirname`-
    // relative path with one resolved under the real native dir. Absent, both
    // constructors fall back to their own unchanged defaults.
    const tapCaptureOpts = wiringCtx.callCaptureNativeDir
      ? { binaryPath: join(wiringCtx.callCaptureNativeDir, 'vendor', 'audiotee', 'audiotee') }
      : {};
    const micCaptureOpts = wiringCtx.callCaptureNativeDir
      ? { binaryPath: join(wiringCtx.callCaptureNativeDir, 'bin', 'mic-capture') }
      : {};
    const baseCallCaptureOpts: CallCaptureToolsOptions = {
      tapCapture: new TapCapture(tapCaptureOpts),
      micCapture: new MicCapture(micCaptureOpts),
      ...(sttResolution.ok ? { sttProvider: sttResolution.provider } : {}),
      memory,
      getSummaryProvider: async () => llm,
    };
    runCallCaptureFn = (personalityId, { source, abortSignal, onEntry, onAudioLevel }) => {
      // Stable per-personality key (mirrors this repo's `cli:<cwd-basename>`
      // session-key convention and the daemon's prior sessionKey construction,
      // relocated here since there is no longer a live turn to carry it).
      const sessionKey = `callcapture:${personalityId}`;
      // Documents-tab mirror target (P4): resolved PER INVOCATION, not once at
      // wiring time — `personalityId` is a runtime parameter (the daemon binds
      // whichever personality accepted the call), so the workdir it maps to can
      // only be known here.
      const documentsWorkdir = resolveCallCaptureDocumentsWorkdir(
        personalities.get(personalityId),
        {
          ethosHome: dataDir,
          self: personalityId,
          cwd: wiringCtx.workingDir,
        },
      );
      // Documents-tab mirror storage boundary: `wiringCtx.storage` is the
      // raw, process-wide Storage — it must never reach `runCallCapture`
      // unscoped. Confine it to this personality's own `fs_reach.workdir`
      // via `ScopedStorage`, the same boundary `DocumentsService`
      // (apps/web-api/src/services/documents.service.ts) enforces for reads
      // of this same directory. Constructed here, per invocation, because
      // `documentsWorkdir` itself is only known per invocation.
      const callCaptureOpts: CallCaptureToolsOptions = {
        ...baseCallCaptureOpts,
        ...(documentsWorkdir
          ? {
              documentsWorkdir,
              storage: new ScopedStorage(wiringCtx.storage, {
                read: [documentsWorkdir],
                write: [documentsWorkdir],
                alwaysDeny: defaultAlwaysDeny(),
              }),
            }
          : {}),
      };
      return runCallCapture(callCaptureOpts, {
        source,
        scopeId: `personality:${personalityId}`,
        sessionId: sessionKey,
        sessionKey,
        platform: 'callcapture',
        workingDir: wiringCtx.workingDir,
        abortSignal,
        ...(onEntry ? { onEntry } : {}),
        ...(onAudioLevel ? { onAudioLevel } : {}),
      });
    };
  }

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
  const llmInjectionClassifier = createLLMClassifier({ llm });
  // plan decision-provider-jev §8.1 — with no `decisions.*` keys the LLM
  // classifier above is used exactly as before, and no provider handle,
  // router or `approverDecision` exists (R7, pinned by
  // `__tests__/decision-wiring.test.ts`).
  //
  // plan decision-provider-personality §7 — with `decisions.*` configured, the
  // three sites below exist, and each resolves ITS mode per call from the
  // turn's personality (`resolvePersonalityDecisionSite`, @ethosagent/config).
  // A personality that declares nothing resolves `off` everywhere: the site
  // calls today's function directly, `decide()` is never called and the vault
  // is never read. ONE lazy provider handle per build (PD8), shared by every
  // site this build wires — the injection classifier here, the smart approver
  // (§8.2), which the approval surfaces construct from `approverDecision` on
  // the result, and the tier router (§8.3) — so all three see the same
  // breaker (§5.5).
  const decisions = config.decisions ? resolveDecisionsConfig(config.decisions) : undefined;
  const decisionSites = decisions
    ? await (async () => {
        const { createDecisionProviderHandle } = await import('./decision-provider');
        const { createDecisionInjectionClassifier } = await import(
          './decision-injection-classifier'
        );
        const { createDecisionTierRouter } = await import('./decision-router');
        const { DecisionRecordTracker } = await import('./decision-site');
        const provider = createDecisionProviderHandle({
          decisions,
          secrets: config.secretsResolver,
          ...(opts.observability ? { observability: opts.observability } : {}),
        });
        // R8 — a `shadow` site never waits for the provider, so its recording
        // can still be in flight when a one-shot command (`ethos -z`) finishes
        // its turn and exits. Every site of this build registers it here, and
        // `dispose()` waits for them — at most the longest site budget, which
        // the provider already enforces per call. Empty → `drain` is a no-op.
        const tracker = new DecisionRecordTracker(
          Math.max(
            decisions.timeouts.injection,
            decisions.timeouts.approver,
            decisions.timeouts.router,
          ),
        );
        disposers.push('decision shadow records', () => tracker.drain());
        const recorder = opts.observability ? { recorder: opts.observability } : {};
        return {
          injectionClassifier: createDecisionInjectionClassifier({
            provider,
            fallback: llmInjectionClassifier,
            global: decisions,
            // The registry this build's loop resolves turns from (§7.2).
            personalities,
            ...(opts.observability ? { observability: opts.observability } : {}),
            tracker,
          }),
          // §8.2 — the approval surfaces build their reviewer from this; the
          // mode is resolved per call from the predicate's personality.
          approverDecision: {
            provider,
            global: decisions,
            ...recorder,
            tracker,
            sinks: APPROVER_DECISION_SINKS,
          } satisfies import('./smart-approver').SmartApproverDecisionSite,
          // §8.3 — injected into the loop below; returns `null` (no routing)
          // for a personality whose router site resolves `off`.
          tierRouter: createDecisionTierRouter({
            provider,
            global: decisions,
            ...recorder,
            tracker,
          }),
        };
      })()
    : undefined;
  const injectionClassifier = decisionSites?.injectionClassifier ?? llmInjectionClassifier;
  const approverDecision = decisionSites?.approverDecision;
  const tierRouter = decisionSites?.tierRouter;

  // -------------------------------------------------------------------------
  // Phase 2 — Build the AgentSafety bundle for core's injected safety path.
  // -------------------------------------------------------------------------

  const {
    INJECTION_DEFENSE_PRELUDE: prelude,
    INJECTION_DEFENSE_PRELUDE_COMPACT: preludeCompact,
    DOWNGRADE_REJECTION_MESSAGE: downgradeRejectionMessage,
    sanitize: sanitizeFn,
    wrapUntrusted: wrapUntrustedFn,
    shortPatternCheck: shortPatternCheckFn,
    c2PatternCheck: c2PatternCheckFn,
    resolveDowngradedTools: resolveDowngradedToolsFn,
  } = await import('@ethosagent/safety-injection');
  const {
    redactPii: redactPiiFn,
    redactString: redactStringFn,
    detectSecrets: detectSecretsFn,
  } = await import('@ethosagent/safety-redact');
  const { ScopedStorage: ScopedStorageCls, defaultAlwaysDeny: defaultAlwaysDenyFn } = await import(
    '@ethosagent/storage-fs'
  );

  const safety: import('@ethosagent/types').AgentSafety = {
    injection: {
      prelude,
      preludeCompact,
      downgradeRejectionMessage,
      sanitize: sanitizeFn,
      wrapUntrusted: wrapUntrustedFn,
      shortPatternCheck: shortPatternCheckFn,
      c2PatternCheck: c2PatternCheckFn,
      resolveDowngradedTools: resolveDowngradedToolsFn,
      classifier: injectionClassifier,
    },
    redaction: {
      redactPii: redactPiiFn,
      redactString: redactStringFn,
      detectSecrets: detectSecretsFn,
    },
    scopedStorageFactory: (base, scope) =>
      new ScopedStorageCls(base, { ...scope, alwaysDeny: defaultAlwaysDenyFn() }),
    // G4 — this composition root gates tool calls behind the danger predicate
    // (`./danger-predicate`, reached via the `before_tool_call` modifying hooks
    // each surface registers). Declaring it makes core verify the claim at the
    // first tool dispatch instead of assuming it.
    approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
    watcher,
  };

  // -------------------------------------------------------------------------
  // E3 — improvement fork
  // -------------------------------------------------------------------------

  let onSkillProposedFn: ((skillId: string, personalityId: string) => void) | undefined;

  // Used by the fork below AND by the SOUL measurement and the delegation tools
  // further down, so it is declared outside the gate. `wiringCtx.storage` is
  // `new FsStorage()` for every ordinary caller (`build-context.ts`); under
  // replay it is the overlay, so the static-floor estimate below is sized on
  // the SHADOWED soul rather than the live one — the two arms must differ only
  // in the candidate.
  const wiringStorage = wiringCtx.storage;
  // M-D6 (plan/phases/trust-before-reach.md Part 3) — `disablePostTurnLearning`
  // is a security gate, not a toggle. The fork turns what a turn SAID into a
  // skill on disk; in a process whose turns are driven by an external MCP
  // client, that is the client writing the operator's skills unattended — a
  // persistent-injection path. The whole block is gated, not just `register()`.
  // Pinned by `packages/wiring/src/__tests__/post-turn-learning.test.ts`.
  //
  // The fork SUBMITS to the learning inbox and never writes a live skill (L-T6).
  // The global `evolve-config.json` `autoApprove` is no longer read here: it is
  // one of the three knobs `learningPolicyFor` (`./learning-pipeline.ts`) reads
  // after a replay, and a replay never runs on `agent_done` (L-D9).
  if (!opts.disablePostTurnLearning) {
    const { ImprovementFork } = await import('@ethosagent/skill-evolver');
    const learningCtx = { storage: wiringStorage, dataDir, personalities };
    const improvementFork = new ImprovementFork({
      hooks,
      runtime: {
        llm,
        memoryProvider: memory,
        sessionStore: session,
        safety,
      },
      personalities,
      dataDir,
      storage: wiringStorage,
      learning: learningSubmitPort(learningCtx),
      // The triggering turn becomes the candidate's target case. Its session
      // key is what `caseFromSessionTurn` checks against X-D7's excluded
      // prefixes, so an eval or cron turn yields no case.
      targetCaseIds: async (payload, personalityId) => {
        const parent = await session.getSession(payload.sessionId);
        if (!parent) return [];
        const id = await freezeLatestUserTurnCase(learningCtx, session, {
          sessionId: payload.sessionId,
          sessionKey: parent.key,
          personalityId,
        });
        return id ? [id] : [];
      },
      onSkillProposed: (candidateId, personalityId) => {
        onSkillProposedFn?.(candidateId, personalityId);
      },
    });
    improvementFork.register();
  }

  // -------------------------------------------------------------------------
  // Gap 10 — process_complete notification via notificationRouter
  // -------------------------------------------------------------------------

  hooks.registerVoid('process_complete', async (event) => {
    const elapsed = `${Math.round(event.durationMs / 1000)}s`;
    const summary =
      event.exitCode === 0
        ? `Process \`${event.processId}\` complete (${elapsed})`
        : `Process \`${event.processId}\` failed (exit ${event.exitCode}, ${elapsed})`;
    const details = event.exitCode !== 0 ? `\n\`\`\`\n${event.stderr.slice(-1000)}\n\`\`\`` : '';
    await notificationRouter.route('process_complete', {
      sessionKey: event.sessionKey,
      message: `${summary}${details}`,
    });
  });

  // -------------------------------------------------------------------------
  // P3 observability — request dump store
  // -------------------------------------------------------------------------

  let requestDumpStore: RequestDumpStore | undefined;
  if (config.observabilityRequestDump?.enabled) {
    const { JsonlRequestDumpStore } = await import('@ethosagent/request-dump');
    const dumpDir = config.observabilityRequestDump.dir ?? join(dataDir, 'request-dumps');
    const dumpStore = new JsonlRequestDumpStore({
      dir: dumpDir,
      maxBytes: config.observabilityRequestDump.rotation?.maxBytes,
    });
    disposers.push('request dump store', () => dumpStore.close());
    requestDumpStore = dumpStore;
  }

  // -------------------------------------------------------------------------
  // Memory provider map (AgentLoop shape)
  // -------------------------------------------------------------------------

  const memoryProviderMap = new Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >();
  // Context assembly resolves `personality.memory.provider` through this map on
  // EVERY turn. Each (provider, options) pair is built once and reused: a
  // backend that holds a connection — memory-vector opens memory.db in its
  // constructor — would otherwise open another per turn and close none. Every
  // one built is released on dispose (F06). Pinned by
  // packages/wiring/src/__tests__/runtime-dispose.test.ts.
  const personalityMemory = new Map<string, Promise<MemoryProvider>>();
  for (const name of memoryProviders.list()) {
    const factory = memoryProviders.get(name);
    if (factory) {
      memoryProviderMap.set(name, (options) => {
        const key = `${name}\0${JSON.stringify(options ?? {})}`;
        const cached = personalityMemory.get(key);
        if (cached) return cached;
        const built = Promise.resolve(
          factory({
            config: options ?? {},
            dataDir,
            secrets: config.secretsResolver ?? NOOP_SECRETS,
            logger: log,
          }),
        );
        // A build that fails is not cached — the next turn tries again.
        built.catch(() => personalityMemory.delete(key));
        personalityMemory.set(key, built);
        return built;
      });
    }
  }
  disposers.push('per-personality memory providers', async () => {
    const built = await Promise.allSettled(personalityMemory.values());
    personalityMemory.clear();
    const closes = await Promise.allSettled(
      built.map((b) => (b.status === 'fulfilled' ? closeMemoryProvider(b.value) : undefined)),
    );
    const failed = closes.filter((c) => c.status === 'rejected');
    if (failed.length > 0) {
      throw new AggregateError(
        failed.map((f) => f.reason),
        `${failed.length} memory provider(s) failed to close`,
      );
    }
  });

  registerBuiltinExtractors(documentExtractors);

  // -------------------------------------------------------------------------
  // AgentLoop construction
  // -------------------------------------------------------------------------

  const activePerson = infra.activePerson;
  const activeMcpPolicy = personalities.getMcpPolicy(activePerson.id);
  const workingDir = wiringCtx.workingDir;

  // §7 — resolve the primary model's effective profile (config override OVER
  // catalog) once and thread its loop-facing fields in. streamStep applies each
  // sampling value only when the per-call RunOptions value is undefined, so
  // precedence is per-call > config override > catalog > provider default. No
  // profile → undefined → no defaults applied (behavior byte-identical to today).
  const resolvedProfile = mergeModelProfile(
    lookupProfile(config.provider, config.model),
    config.models?.[`${config.provider}/${config.model}`],
  );
  const modelSampling = resolvedProfile?.sampling;

  // §5 — resolve the effective compaction gate config: per-model profile OVER
  // global `compaction:` config (charsPerToken is per-model only). All absent →
  // undefined → the gate behaves exactly as it does today.
  const compactionGate = resolveCompactionGate(resolvedProfile, config.compaction);
  // Phase 1c — `gateDelta` is global-only (a token headroom, not a fraction);
  // merge it onto the resolved gate so the loop's actuals-first gate can use it.
  const gateDelta = config.compaction?.gateDelta;

  // Phase 3 — per-model-class default engine (frontier + summarizer wired →
  // semantic_summary; else drop_oldest) plus the turn-end auto-compact and
  // overflow-retry flags. These only apply when the personality declares no
  // `context_engine`; a personality override always wins.
  const summarizerWired = llmHandle?.summarize !== undefined;
  const defaultEngine = resolveDefaultContextEngine(llm.maxContextTokens, summarizerWired);
  const autoCompact = config.compaction?.autoCompact;
  const retryOnOverflow = config.compaction?.retryOnOverflow;
  const abortOnSummaryFailure = config.compaction?.abortOnSummaryFailure;
  // Item 7 — global-only knobs (no per-model layer, since that would mean a
  // `packages/types` change): the absolute context-token ceiling that lowers
  // BOTH gates, and the guaranteed verbatim user tail.
  const maxContextTokens = config.compaction?.maxContextTokens;
  const minTailUserMessages = config.compaction?.minTailUserMessages;
  const compaction = {
    ...(compactionGate ?? {}),
    ...(gateDelta !== undefined ? { gateDelta } : {}),
    ...(autoCompact !== undefined ? { autoCompact } : {}),
    ...(retryOnOverflow !== undefined ? { retryOnOverflow } : {}),
    ...(abortOnSummaryFailure !== undefined ? { abortOnSummaryFailure } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(minTailUserMessages !== undefined ? { minTailUserMessages } : {}),
    defaultEngine,
  };
  const memoryConsolidation = config.memoryConsolidation;

  // §2 — the resolved profile's prompt-economy knobs (compact prelude, memory
  // cap, guidance suppression). Absent → context assembly unchanged.
  const profilePromptBudget = resolvedProfile?.promptBudget;

  // Phase 4 — small-window mode, decided here for the STARTUP personality from
  // static inputs (other personalities: the per-personality resolver below,
  // memoized so each prompt prefix stays byte-stable). Triggers on a small window
  // (≤32k) OR when the measured static overhead (SOUL + prelude + tool schemas
  // + the project-context injection for the startup working directory)
  // exceeds 40% of the window. When active, it forces the compact prelude,
  // index-not-content personality memory, index-mode skills, and a scaled
  // history limit. A config `compaction.smallWindow` (auto|on|off) overrides the
  // triggers. NOTE: tool schemas registered AFTER loop construction (delegation,
  // goal, MCP) are not counted in the static estimate — the estimate is
  // best-effort and biases slightly low; the window trigger is exact.
  const preludeChars = (profilePromptBudget?.compactPrelude ? preludeCompact : prelude).length;
  // D8 — the ONE static-floor arithmetic, shared with `ethos bench context`,
  // the Lane 1(b) startup diagnostic below and the per-personality resolver.
  const measureFloor = async (person: PersonalityConfig, projectContextChars: number) => {
    let soulChars = 0;
    if (person.soulFile) {
      try {
        soulChars = (await wiringStorage.read(person.soulFile))?.length ?? 0;
      } catch {
        soulChars = 0;
      }
    }
    const definitions = tools.toDefinitions(person.toolset);
    return measureStaticFloor({
      soulChars,
      toolSchemaChars: JSON.stringify(definitions).length,
      toolCount: definitions.length,
      preludeChars,
      projectContextChars,
    });
  };
  const toolDefinitions = tools.toDefinitions(activePerson.toolset);
  // The AGENTS.md/CLAUDE.md "Project Context" block the first turn will send,
  // asked of the loop's own file-context injector for the directory the turn
  // resolves — the same text, not a second discovery (project-context-floor.ts).
  const startupWorkdir = resolveTurnWorkdir(activePerson, { dataDir, cwd: workingDir });
  const projectContextOf = (person: PersonalityConfig, workdir: string) =>
    projectContextFor({
      injectors,
      personality: person,
      workdir,
      platform: profile,
      model: llm.model,
    });
  const projectContext =
    startupWorkdir !== undefined ? await projectContextOf(activePerson, startupWorkdir) : '';
  const staticFloor = await measureFloor(activePerson, projectContext.length);
  const staticTokens = staticFloor.tokens;
  const smallWindow = resolveSmallWindowMode({
    contextWindow: llm.maxContextTokens,
    staticTokens,
    ...(config.compaction?.smallWindow ? { override: config.compaction.smallWindow } : {}),
  });
  if (smallWindow) {
    log.warn(
      smallWindowModeMessage({
        personalityId: activePerson.id,
        windowTokens: llm.maxContextTokens,
        floor: staticFloor,
        ...(config.compaction?.smallWindow ? { override: config.compaction.smallWindow } : {}),
      }),
    );
  }
  // Small-window defaults first, then let any explicit profile knobs win.
  const smallWindowOverlay = {
    promptBudget: {
      compactPrelude: true,
      suppressMemoryGuidance: true,
      memoryIndexMode: true,
      skillsIndexMode: true,
      memorySnapshotCap: 4_000,
      ...profilePromptBudget,
    },
    historyLimit: scaleHistoryLimit(llm.maxContextTokens),
  };
  // Post-review FIX 2 — ONE hardened local-runtime classification for this
  // loop's provider endpoint, shared by the payload guard below and the
  // FIX 1 result-budget gate. Known hosted aliases never classify as local.
  const localRuntime = detectLocalRuntime(config.provider, config.baseUrl ?? '') !== undefined;
  // Lane 1(c)+(e) — scale the per-turn tool-result budget DOWN with the served
  // window; never UP (the flat 80k default is the ceiling, #111762). An
  // explicit per-personality `context_engine_options.resultBudgetChars` may
  // lower it further, never raise it past the ceiling. Post-review FIX 1: the
  // scaling engages ONLY on a detected local runtime or that explicit knob —
  // hosted providers with small catalog windows keep the flat 80k default and
  // no gate-reserve term (the hosted-parity law). Sized from EACH personality's
  // own static floor, per turn, by the resolver below.
  const resultBudgetFor = (person: PersonalityConfig, staticFloorTokens: number) => {
    const raw = person.context_engine_options?.resultBudgetChars;
    return resolveResultBudgetGate({
      windowTokens: llm.maxContextTokens,
      staticFloorTokens,
      localRuntime,
      ...(typeof raw === 'number' && raw > 0 ? { configured: raw } : {}),
    });
  };
  // Per-personality window decisions. Every personality's turns run with its
  // OWN static prefix — its SOUL, toolset and the project context of the
  // workdir its turns resolve — so small-window mode and the tool-result
  // budget are asked per turn of a resolver (`createSmallWindowResolver`,
  // small-window-resolver.ts; applied by `setupTurn`,
  // packages/core/src/agent-loop/stages/turn-setup.ts, and `withSmallWindow`,
  // packages/core/src/agent-loop/small-window.ts). The loop-level options
  // below are only the baseline a resolver-less path (manual `/compact`
  // without one, tests) sees.
  const smallWindowResolver = createSmallWindowResolver({
    windowTokens: llm.maxContextTokens,
    model: config.model,
    ...(config.compaction?.smallWindow ? { override: config.compaction.smallWindow } : {}),
    smallWindowOverlay,
    resultBudget: resultBudgetFor,
    projectContext: projectContextOf,
    measureFloor,
    logger: log,
    ...(startupWorkdir !== undefined
      ? {
          seed: {
            personality: activePerson,
            workdir: startupWorkdir,
            projectContext,
            floor: staticFloor,
          },
        }
      : {}),
  });
  const promptBudget = profilePromptBudget;

  // Lane 1(b) — startup floor check, WARN-FIRST (plan risk note: some configs
  // that "work" today only work because the server silently truncates; refuse
  // only after a release of warning). `evaluateContextFit` produces the
  // message so Lane 6's fit verdict reuses the identical diagnostic.
  const contextFit = evaluateContextFit({
    personalityId: activePerson.id,
    model: config.model,
    windowTokens: llm.maxContextTokens,
    floor: staticFloor,
  });
  if (contextFit.message) log.warn(contextFit.message);

  // Lane 3(b) — declared small-window toolset narrowing (D20). The narrowing
  // itself is enforced in the loop's turn setup (per-turn personality, gating
  // BOTH toDefinitions and executeParallel); here wiring makes it VISIBLE —
  // a startup diagnostic naming the personality and the surviving tools — and
  // measures the guard/budget below against the EFFECTIVE (narrowed) payload.
  const declaredSmallSet = parseSmallWindowToolset(
    activePerson.context_engine_options?.small_window_toolset,
  );
  const narrowedToolset =
    smallWindow && declaredSmallSet
      ? activePerson.toolset
        ? activePerson.toolset.filter((t) => declaredSmallSet.includes(t))
        : declaredSmallSet
      : undefined;
  if (narrowedToolset) {
    log.info(
      `startup personality \`${activePerson.id}\`: small-window mode narrows it to its declared ` +
        `small_window_toolset — surviving tools: ${narrowedToolset.join(', ') || '(none)'} ` +
        `(other personalities are decided per turn)`,
    );
  }
  const effectiveToolDefinitions = narrowedToolset
    ? tools.toDefinitions(narrowedToolset)
    : toolDefinitions;

  // Lane 3(a) — total serialized tool-payload guard. On a local dialect an
  // over-limit payload FAILS startup (llamacpp-class runtimes lose tool
  // calling entirely — the failure this prevents); hosted dialects WARN. In
  // neither case is the problem deferred to the first tool call.
  const payloadGuard = evaluateToolPayloadGuard({
    toolDefinitions: effectiveToolDefinitions,
    localDialect: localRuntime,
    ...(config.toolPayloadLimitChars !== undefined
      ? { limitChars: config.toolPayloadLimitChars }
      : {}),
  });
  if (payloadGuard.message) {
    if (payloadGuard.severity === 'fail') throw new Error(payloadGuard.message);
    log.warn(payloadGuard.message);
  }

  // Lane 3(b) — per-personality tool-schema budget warning. Same chars/4
  // numbers `measureStaticFloor` / `ethos bench context` report (D8); default
  // threshold reuses SMALL_WINDOW_STATIC_RATIO (0.4). A personality that
  // declared a small-window toolset is measured on its narrowed payload; one
  // that declared nothing keeps its full toolset and gets this warning.
  const budgetRatio = activePerson.context_engine_options?.tool_schema_budget_ratio;
  const schemaBudget = evaluateToolSchemaBudget({
    personalityId: activePerson.id,
    windowTokens: llm.maxContextTokens,
    toolDefinitions: effectiveToolDefinitions,
    ...(typeof budgetRatio === 'number' && budgetRatio > 0 ? { ratio: budgetRatio } : {}),
  });
  // reach-and-containment Part 1 (C5) — the per-turn on-demand tool-loading
  // resolver. Passed to the loop only when not `off`, so an `off` loop's config
  // is byte-identical to before. The startup warning above says when the
  // startup personality would engage it.
  const toolLoadingMode = config.toolLoading ?? 'auto';
  const toolLoading =
    toolLoadingMode === 'off'
      ? undefined
      : createToolLoadingResolver({ mode: toolLoadingMode, windowTokens: llm.maxContextTokens });
  if (schemaBudget.message) {
    let clause = '';
    if (toolLoading?.(activePerson, effectiveToolDefinitions)) {
      const pinned = resolvePinned(activePerson, effectiveToolDefinitions, tools);
      clause =
        ` — on-demand tool loading engaged (${pinned.size} pinned, ` +
        `${effectiveToolDefinitions.length - pinned.size} searchable)`;
    }
    log.warn(schemaBudget.message + clause);
  }

  // The startup personality's budget — the loop-level baseline.
  const { resultBudgetChars, maxSingleToolResultTokens } = resultBudgetFor(
    activePerson,
    staticFloor.tokens,
  );

  const loop = new AgentLoop({
    llm,
    tools,
    session,
    memory,
    personalities,
    injectors,
    injectorPluginIds,
    hooks,
    // The handle the loop reads SOUL.md and skills through
    // (`stages/context-assembly.ts` `deps.storage.read(personality.soulFile)`,
    // `SkillsInjector`). `wiringCtx.storage` is `new FsStorage()` for every
    // ordinary caller (`build-context.ts`) and the replay overlay for a replay
    // arm — which is what makes the shadowed bytes the ones the model sees.
    storage: wiringCtx.storage,
    attachmentCache: infra.capabilityBackends.attachmentCache,
    dataDir,
    // Off under replay — see `session`/`contextLog` above.
    ...(opts.replay ? {} : { contentStore, contextLog }),
    // D7/T1.5/T1.8 — the resolver's context. The registry is the one
    // `parseConfigYaml` already built from `modelRegistry.*` (never re-parsed
    // here); absent or empty it is the D11b legacy path, which is today's
    // behaviour exactly (`resolveTurnModel` in packages/core/src/agent-loop/turn-model.ts).
    modelResolution: {
      registry: config.modelRegistry ?? { entries: {}, roles: {} },
      routing: config.modelRouting ?? {},
      // D11c — the catalog the legacy family shim reads; core cannot import it.
      catalogModelId: lookupLegacyCatalogModelId,
    },
    ...(modelSampling ? { modelSampling } : {}),
    compaction: {
      ...compaction,
      ...(maxSingleToolResultTokens !== undefined ? { maxSingleToolResultTokens } : {}),
    },
    ...(memoryConsolidation ? { memoryConsolidation } : {}),
    ...(promptBudget ? { promptBudget } : {}),
    memoryProviders: memoryProviderMap,
    safety,
    logger: log,
    ...(toolLoading ? { toolLoading } : {}),
    smallWindowResolver,
    ...(tierRouter ? { tierRouter } : {}),
    // §15.3 — the approver's private sink channel; the same object is on
    // `approverDecision.sinks` above. Absent with no `decisions.*`.
    ...(decisionSites ? { approverDecisionSinks: APPROVER_DECISION_SINKS } : {}),
    documentExtractors,
    contextEngines,
    ...(llmHandle ? { llmHandle } : {}),
    clarifyBridge: infra.clarifyBridge,
    ...(config.teamName ? { teamId: config.teamName } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    // Ground-truth verification (T4). Only passed when grounding is enabled, so
    // an opted-out loop's config is byte-identical to today's.
    ...(toolsResult.turnAuditors.length > 0 ? { turnAuditors: toolsResult.turnAuditors } : {}),
    ...(requestDumpStore ? { requestDumpStore } : {}),
    ...(activeMcpPolicy ? { mcpPolicy: activeMcpPolicy } : {}),
    // openclaw-9.5 item 1 — set for EVERY host (all of them assemble through
    // here), but it only runs for a turn whose surface passes
    // `RunOptions.credentialPrompt` (`stages/turn-setup.ts`). Plugin
    // credentials only: browser logins (`credentials/<name>/`) stay a
    // `browser_fill_credential` refusal — see `buildCredentialCheck`.
    credentialCheck: buildCredentialCheck({
      pluginLoader,
      ...(opts.observability ? { observability: opts.observability } : {}),
      logger: log,
    }),
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
      // Lane 1(c) — only passed when scaling engaged; at the ceiling the loop
      // default (80k) applies and the config is byte-identical to today.
      ...(resultBudgetChars < RESULT_BUDGET_CEILING_CHARS ? { resultBudgetChars } : {}),
      // Soft-warn tiers — only passed when configured, so an unconfigured loop
      // never produces a warn event.
      ...(config.toolLoop?.maxToolCallsWarnAt !== undefined
        ? { maxToolCallsWarnAt: config.toolLoop.maxToolCallsWarnAt }
        : {}),
      ...(config.toolLoop?.maxIdenticalToolCallsWarnAt !== undefined
        ? { maxIdenticalToolCallsWarnAt: config.toolLoop.maxIdenticalToolCallsWarnAt }
        : {}),
      // Hard caps — only passed when configured, so an unconfigured loop keeps
      // its own defaults (1000 / 25).
      ...(config.toolLoop?.maxToolCallsPerTurn !== undefined
        ? { maxToolCallsPerTurn: config.toolLoop.maxToolCallsPerTurn }
        : {}),
      ...(config.toolLoop?.maxIdenticalToolCalls !== undefined
        ? { maxIdenticalToolCalls: config.toolLoop.maxIdenticalToolCalls }
        : {}),
    },
  });

  // --- Background sub-agent engine (durable spawn-and-continue) ---
  const bg = { ...backgroundDefaults(), ...(config.background ?? {}) };
  // Default ON for long-lived surfaces; OFF for one-shot CLI invocations that exit
  // immediately (a job spawned in a dying process would never run). An explicit
  // config.background.enabled always wins.
  const backgroundEnabled = config.background?.enabled ?? !(opts.oneShot ?? false);

  let jobStore: SQLiteJobStore | undefined;
  let backgroundExecutor: BackgroundExecutor | undefined;
  // Exposed on the result so the web-api's Tasks detail RPC can ask the runner
  // that executed a row for its own detail-grid rows (pi-delegation D18).
  let jobRunnerRegistry: import('@ethosagent/types').JobRunnerRegistry | undefined;
  let backgroundDeps: BackgroundToolDeps | undefined;
  let meshProxyReconciler: MeshProxyReconciler | undefined;
  if (backgroundEnabled) {
    jobStore = new SQLiteJobStore(join(dataDir, 'jobs.db'));
    // Lent to hosts as `CreateAgentLoopResult.jobStore` (gateway, Tasks tab);
    // its lifetime is this loop's. Released after the executor and reconciler
    // below (reverse order), so no worker writes to a closed handle.
    const ownedJobStore = jobStore;
    disposers.push('job store', () => ownedJobStore.close());
    // G2/G3/D7 — a background job's clarify routes to wherever a live human
    // is currently present (see `ClarifyBridge.resolveRouting`), falling back
    // to the job's own origin lane. That fallback needs to look the job up;
    // only wired here, where a `JobStore` actually exists (no jobs, no
    // resolver to ask about them).
    const jobStoreForClarify = jobStore;
    infra.clarifyBridge.setOriginResolver(async (jobId) => {
      const job = await jobStoreForClarify.get(jobId);
      return resolveJobClarifyOrigin(job);
    });
    // Owner is unique per executor instance so multiple loops in one process
    // (multi-bot gateway) never race on claimNextQueued and each runs only its
    // own jobs. randomBytes suffix distinguishes same-profile same-pid instances.
    const owner = `${profile}:${process.pid}:${randomBytes(3).toString('hex')}`;
    // Runner seam. `ethos` — the in-process AgentLoop path — is the default and
    // the only runner registered here; an out-of-process harness registers its
    // own factory and nothing else in this file changes. Resolved eagerly
    // because both the executor and `delegate_task` read instances, not
    // factories.
    const jobRunners = new DefaultJobRunnerRegistry();
    jobRunnerRegistry = jobRunners;
    jobRunners.register(ETHOS_RUNNER_NAME, () => new EthosJobRunner(loop));
    await jobRunners.resolve(ETHOS_RUNNER_NAME, { logger: log });
    // Pi — out-of-process, in a container. Registered only when the deployment
    // names a digest-pinned image (there is nothing sane to default to), so an
    // un-provisioned machine answers `not_available` rather than failing at
    // spawn time. The docker backend comes from the SAME registry (and, by its
    // cache, is the SAME instance) exec tools use: D4's containment claim rests
    // on one mount derivation, not two.
    const piConfig = config.background?.pi;
    // T4/I3 — each configured id becomes its own registered runner (`runner:
    // 'claude'`, `runner: 'gemini'`), never one generic `'acp'` runner (see
    // plan/phases/acp-job-runner.md's Config shape). Absent `background.acp`
    // means the roster is empty and nothing below the guard runs.
    const acpAgentsConfig = config.background?.acp?.agents ?? {};
    const acpAgentNames = Object.keys(acpAgentsConfig);
    let interactionRouter: InteractionRouter | undefined;
    // Shared `InteractionRouter` construction: Pi and any configured ACP agent
    // both gate their tool calls through the SAME router instance (D17's
    // per-run allowance cache, D16's auto-resolving capabilities, the same
    // clarify escalation chain) — constructed once, whenever EITHER is
    // configured, so ACP agents can route interactions even when Pi itself
    // is absent from this deployment.
    if (piConfig?.image || acpAgentNames.length > 0) {
      // Phase 4 — every gated Pi/ACP tool call goes through the runner-agnostic
      // router: cached answer (D17), auto-resolving capability (D16), or the
      // existing clarify chain. `secret` is registered so a runner that ever
      // emits that kind fails closed instead of writing secret material into a
      // persisted clarify row (§4.5); no runner emits it today.
      const router = new InteractionRouter({
        escalate: createClarifyEscalator({
          bridge: infra.clarifyBridge,
          jobs: jobStoreForClarify,
          // I11 — a run parked on a human question is `blocked`, not `running`:
          // its heartbeat pauses so the stale sweep leaves it alone, and the
          // card can say why it is sitting there. The executor is constructed
          // below, so this reads it late through the same `let` binding
          // `backgroundDeps.nudge` uses — the closure only fires when a worker
          // actually asks something, long after assignment.
          blocking: {
            block: async (id, requestId) => {
              await backgroundExecutor?.markJobBlocked(id, requestId);
            },
            resume: async (id) => {
              await backgroundExecutor?.resumeJob(id);
            },
          },
          // Only the bridge's last-resort route: a background clarify resolves
          // its real destination from the job's origin lane + presence
          // (G2/G3/D7), which is wired above.
          ...(isClarifySurfaceType(profile) ? { fallbackSurfaceType: profile } : {}),
        }),
        logger: log,
      });
      router.registry.register(SECRET_KIND, createSecretHandler());
      interactionRouter = router;

      // Pi — out-of-process, in a container. Registered only when the
      // deployment names a digest-pinned image (there is nothing sane to
      // default to), so an un-provisioned machine answers `not_available`
      // rather than failing at spawn time. The docker backend comes from the
      // SAME registry (and, by its cache, is the SAME instance) exec tools
      // use: D4's containment claim rests on one mount derivation, not two.
      //
      // ALWAYS docker, never the personality's posture: a Pi run is a container
      // by construction — a digest-pinned image, a mount set derived from
      // `fs_reach`, a workspace `git worktree`. An `ssh` posture routes the
      // exec TOOLS to a remote host; it does not turn this runner into
      // something a remote shell could host. A personality with `execution:
      // ssh` still gets its Pi jobs in a local container.
      if (piConfig?.image) {
        const piBackend = await infra.executionBackends.resolve('docker', {
          config: {
            substitutionVars: { ethosHome: dataDir, cwd: wiringCtx.workingDir },
            constitution: infra.constitution,
          },
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        });
        jobRunners.register(
          PI_RUNNER_NAME,
          () =>
            new PiJobRunner({
              backend: piBackend,
              resolvePersonality: (id) => personalities.get(id),
              ethosHome: dataDir,
              cwd: wiringCtx.workingDir,
              image: piConfig.image,
              ...(piConfig.memoryMb !== undefined ? { memoryMb: piConfig.memoryMb } : {}),
              ...(piConfig.configDir ? { piConfigDir: piConfig.configDir } : {}),
              gate: createRouterGate(router, log),
              logger: log,
            }),
        );
        await jobRunners.resolve(PI_RUNNER_NAME, { logger: log });
      }

      // Real ACP-native coding agents — one registered JobRunner per
      // configured agent id (D-ACP2: one package, many agents; each entry
      // its own `runner` name). Same docker backend/mount derivation as Pi
      // (D4) — resolved ONCE here and shared across every configured agent,
      // not re-resolved per entry; resolving 'docker' again returns the SAME
      // cached instance either way.
      // Docker for the same reason Pi is (above): an ACP agent run is
      // container-specific, so an `ssh` posture on the personality does not
      // move it to the remote host.
      if (acpAgentNames.length > 0) {
        const acpBackend = await infra.executionBackends.resolve('docker', {
          config: {
            substitutionVars: { ethosHome: dataDir, cwd: wiringCtx.workingDir },
            constitution: infra.constitution,
          },
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        });
        await registerAcpJobRunners({
          jobRunners,
          acpAgents: acpAgentsConfig,
          backend: acpBackend,
          resolvePersonality: (id) => personalities.get(id),
          ethosHome: dataDir,
          cwd: wiringCtx.workingDir,
          gate: createAcpRouterGate(router, log),
          logger: log,
        });
      }
    }
    backgroundExecutor = new BackgroundExecutor({
      store: jobStore,
      loop,
      runners: jobRunners,
      owner,
      // F06 — who inherits this executor's queued rows when its loop is
      // disposed. A bot's loop: any loop answering as the same bot — the
      // replacement after a live bot edit, or the next boot's. A loop with no
      // bot identity: only a successor in THIS process (desktop restart, a
      // chat model switch) — `ethos chat`, `ethos serve` and `ethos gateway`'s
      // system loop may share one jobs.db, and none may run another's jobs.
      affinity: `${profile}:${opts.originBotKey ?? `pid-${process.pid}`}`,
      config: {
        maxConcurrentJobs: bg.maxConcurrentJobs,
        staleMs: bg.staleMs,
        heartbeatMs: bg.heartbeatMs,
        queuedTtlMs: bg.queuedTtlMs,
        maxRootBackgroundUsd: bg.maxRootBackgroundUsd,
        retentionMs: bg.retentionDays * 86_400_000,
      },
      log: (msg) => log.info(`[background] ${msg}`),
      // Phase 5 — cancelling a run withdraws whatever question it is parked
      // on. Without this, `task_cancel` on a `blocked` job aborts the run but
      // leaves its clarify live on someone's phone for the rest of its window
      // (now up to the 24 h park), and the escalator's `resume` — which
      // un-pauses the heartbeat — never runs because `request()` never settles.
      cancelInteractions: async (jobId) => {
        await infra.clarifyBridge.cancelJob(jobId);
      },
    });
    backgroundExecutor.start();
    // Stops claiming, hands its queued rows on (`affinity` above), aborts every
    // active run and awaits each one's unwind — a run finishes itself as
    // `aborted` with `JOB_ABORTED_BY_SHUTDOWN` (`BackgroundExecutor.shutdown`,
    // extensions/job-runner/src/index.ts).
    const executor = backgroundExecutor;
    disposers.push('background executor', () => executor.shutdown());
    if (interactionRouter) {
      // D17 — a run's remembered allowances die with the run. `onComplete`
      // fires on every terminal transition, which is exactly the boundary
      // "allow for this run" was scoped to.
      const router = interactionRouter;
      backgroundExecutor.onComplete((job) => router.forgetJob(job.id));
    }
    backgroundDeps = {
      store: jobStore,
      nudge: () => backgroundExecutor?.nudge(),
      runners: jobRunners,
      owner,
      defaultMaxCostUsd: bg.defaultMaxCostUsd,
      maxJobsPerRoot: bg.maxJobsPerRoot,
      maxJobsPerPersonality: bg.maxJobsPerPersonality,
      staleMs: bg.staleMs,
      ...(opts.originBotKey ? { originBotKey: opts.originBotKey } : {}),
      ...(opts.resolveOriginThreadId ? { resolveOriginThreadId: opts.resolveOriginThreadId } : {}),
    };

    // Mesh proxy reconciler — polls peers for background jobs spawned via
    // route_to_agent(background:true) and mirrors their status onto local proxy
    // rows. Uses plain globalThis.fetch: it runs OUTSIDE any turn and only
    // contacts mesh peers from the registry, so it bypasses per-personality
    // network policy by design.
    meshProxyReconciler = new MeshProxyReconciler({
      store: jobStore,
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      log: (m) => log.info(`[mesh-reconciler] ${m}`),
    });
    meshProxyReconciler.start();
    const reconciler = meshProxyReconciler;
    disposers.push('mesh proxy reconciler', () => reconciler.stop());
  }

  // Delegation tools need the loop reference; register after loop creation.
  for (const tool of createDelegationTools(
    loop,
    wiringStorage,
    opts.meshRegistryPath,
    backgroundDeps,
  ))
    tools.register(tool);

  // `agent_consult` — the hosted-realtime voice surface's one call back into
  // the agent. Loop-bearing for the same reason the delegation tools are, so it
  // registers here rather than in `compose-tools`. Registered UNCONDITIONALLY:
  // the realtime seam advertises what the registry actually holds
  // (`deriveRealtimeToolset`), so a conditional registration would silently
  // produce a session that offers nothing and a model that stops asking.
  //
  // The voice origin is fixed to browser talk-mode because that is the only
  // surface whose realtime session opens behind the operator's own credentials —
  // `voice.realtimeToken` mints behind the web-api session cookie.
  //
  // A PHONE CALL MUST NOT USE THIS INSTANCE. V4's call path builds its own via
  // `createFarEndConsultTool` (`./far-end-consult`), which pins
  // `speaker: 'far_end'` and, for a screened caller, the receptionist
  // personality. The spoken-confirmation gate refuses a far-end caller BEFORE
  // consulting any confirmation record, and that refusal keys on exactly this
  // field — so reusing the owner's instance on a call would promote every
  // stranger to the operator.
  tools.register(
    createAgentConsultTool(loop, {
      voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
    }),
  );

  // Goal runner — loop-bearing, constructed after the loop exists (mirrors
  // createDelegationTools handing the loop to tools post-construction). Shares
  // the single goalStore from tool composition via goalRunnerRef late-binding.
  // Always built so web-created goals execute for any personality, regardless of
  // whether the personality exposes goal_* tools.
  // Interactive tools that break goal autonomy: a fire-and-forget goal run has no
  // user to answer them, so a call would hang the run forever. Stripped from the
  // goal session's effective toolset. Extend this set as new interactive tools land.
  const GOAL_EXCLUDED_TOOLS = new Set(['clarify']);
  // Read-only planning toolset. The Tool contract carries no read-only/mutates
  // signal (only `toolset` groups), so planning is gated by an explicit allowlist
  // of known non-mutating tool names, intersected with the personality's toolset.
  // This deliberately excludes goal_complete and every mutating/execution tool:
  // the planning turn investigates and writes a plan, it must not change state.
  // When the personality toolset can't be resolved the intersection is empty
  // (planning still produces a plan from the goal text) — never the full toolset.
  const GOAL_PLAN_READONLY_TOOLS = new Set([
    'read_file',
    'search_files',
    'web_search',
    'web_extract',
    'memory_read',
    'session_search',
    'session_list_by_date',
    'team_memory_read',
    'team_memory_search',
  ]);
  const goalRunner = new GoalRunner({
    store: goalStore,
    hooks,
    runAttempt: (sessionKey, firstMessage, o) => {
      const ptoolset = o.personalityId ? personalities.get(o.personalityId)?.toolset : undefined;
      const toolsetOverride = ptoolset?.filter((t) => !GOAL_EXCLUDED_TOOLS.has(t));
      return loop.run(firstMessage, {
        sessionKey,
        abortSignal: o.abortSignal,
        ...(o.steerSink ? { steerSink: o.steerSink } : {}),
        ...(o.personalityId ? { personalityId: o.personalityId } : {}),
        ...(o.userId ? { userId: o.userId } : {}),
        ...(o.maxToolCallsPerTurn != null ? { maxToolCallsPerTurn: o.maxToolCallsPerTurn } : {}),
        ...(o.maxIdenticalToolCalls != null
          ? { maxIdenticalToolCalls: o.maxIdenticalToolCalls }
          : {}),
        ...(o.allowDangerousToolCalls ? { allowDangerousToolCalls: true } : {}),
        ...(toolsetOverride ? { toolsetOverride } : {}),
      });
    },
    runPlan: (sessionKey, firstMessage, o) => {
      const ptoolset = o.personalityId ? personalities.get(o.personalityId)?.toolset : undefined;
      const readOnlyToolset = (ptoolset ?? []).filter((t) => GOAL_PLAN_READONLY_TOOLS.has(t));
      return loop.run(firstMessage, {
        sessionKey,
        abortSignal: o.abortSignal,
        ...(o.personalityId ? { personalityId: o.personalityId } : {}),
        ...(o.userId ? { userId: o.userId } : {}),
        toolsetOverride: readOnlyToolset,
      });
    },
  });
  // Lease-gated (GoalRunner.recoverOrphans → SQLiteGoalStore.interruptStale):
  // interrupts only goals whose runner stopped heartbeating, so building this
  // loop beside another live runner on the same goals.db leaves its goals alone.
  goalRunner.recoverOrphans();
  // Registered after the goal store (compose-tools), so it runs BEFORE goals.db
  // closes: in-flight goal runs are aborted and awaited, ending `interrupted`.
  disposers.push('goal runner', () => goalRunner.shutdown());
  goalRunnerRef.runner = goalRunner;

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

  // -------------------------------------------------------------------------
  // memory-experience pillar B — proactive capture (default-off, §3)
  // -------------------------------------------------------------------------
  let onMemoryCapturedFn:
    | ((cb: (n: { sessionId: string; scopeId: string; summary: string }) => void) => () => void)
    | undefined;
  /** Present only when proactive capture is enabled — see `drain` below. */
  let captureIdle: (() => Promise<void>) | undefined;
  // The second half of M-D6: capture reads the turn and writes memory with no
  // human in the loop, so an export process must not run it either.
  if (
    config.memoryCapture?.enabled &&
    !opts.disablePostTurnLearning &&
    (memoryName === 'markdown' || memoryName === 'vault')
  ) {
    const captureConfig = config.memoryCapture;
    // Undecorated write provider + its own HistoryStore: the runner records
    // history itself (with hint + capture hashes), so it must not double-record
    // through a decorated handle. Backend-aware: under `memory: vault` the base
    // is a ScopedStorage-confined VaultMemoryProvider and the history roots at
    // the vault's `.ethos-meta`; tombstones (below) stay at ~/.ethos.
    const { base: captureBase, history: captureHistory } = createUndecoratedBackend({
      selection: config,
      dataDir,
      storage: wiringCtx.storage,
      logger: log,
    });

    // Extraction model: dedicated cheap aux model when configured, else reuse
    // the primary provider (open-question 2 — zero-config installs pay primary).
    let captureLlm: LLMProvider = llm;
    if (captureConfig.model && captureConfig.model !== config.model) {
      const auxProviderName = captureConfig.provider ?? config.provider;
      const auxFactory = infra.llmProviders.get(auxProviderName);
      if (auxFactory) {
        captureLlm = await auxFactory({
          config: {
            provider: auxProviderName,
            model: captureConfig.model,
            apiKey: captureConfig.apiKey ?? config.apiKey,
            ...((captureConfig.baseUrl ?? config.baseUrl)
              ? { baseUrl: captureConfig.baseUrl ?? config.baseUrl }
              : {}),
            ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
          },
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        });
      } else {
        log.warn(
          `memoryCapture provider "${auxProviderName}" not registered; ` +
            'capture extraction will reuse the primary model',
        );
      }
    }

    // Inline consolidation fallback (§3.5): only when no macro-loop is
    // configured. Reuses the pure consolidateMemory(); the consolidation write
    // is recorded through a history-decorated handle so it lands as
    // `source: 'consolidation'`.
    const nightlyConfigured = config.nightlyPass?.enabled === true;
    const consolidationHandle = withHistory(captureBase, captureHistory, {
      source: 'consolidation',
    });
    const consolidate: ConsolidateFn = async ({ ctx }) => {
      const memBefore = (await captureBase.read('MEMORY.md', ctx))?.content ?? '';
      const userBefore = (await captureBase.read('USER.md', ctx))?.content ?? '';
      const result = await consolidateMemory(
        { memory: memBefore, user: userBefore, recentContext: '' },
        llm,
      );
      const updates = buildConsolidationUpdates({ memory: memBefore, user: userBefore }, result);
      if (updates.length > 0) await consolidationHandle.sync(updates, ctx);
    };

    // Approve-before-store gate (memory-lifecycle L2). When approval gates the
    // `capture` source, the runner PROPOSES each fresh fact to the pending queue
    // (with its exact fact-hash) instead of writing durably; approval replays it
    // through the history-recording path. The tombstone store is passed
    // unconditionally so a fact rejected while gating was on stays skipped even
    // if approval is later disabled.
    //
    // Evidence-gated promotion (plan openclaw-9.5-adoption item 3, D22):
    // `memoryCapture.evidenceSessions: N > 0` routes capture through the queue
    // even with approval `off`, as a capture-only queue that promotes an entry
    // once N distinct sessions have extracted it (`PendingMemoryStore.propose`,
    // `autoPromote`). Under `automated`/`all` evidence only orders the queue —
    // a human still approves. Pinned by
    // `__tests__/memory-evidence-wiring.test.ts`.
    const approvalMode = config.memoryApproval?.mode ?? 'off';
    const captureGated = approvalMode === 'automated' || approvalMode === 'all';
    const evidenceSessions = captureConfig.evidenceSessions ?? 0;
    const captureTombstones = new TombstoneStore({ storage: wiringCtx.storage, dataDir });
    let capturePropose: ProposeFn | undefined;
    if (captureGated || evidenceSessions > 0) {
      const pending = new PendingMemoryStore({
        storage: wiringCtx.storage,
        dataDir,
        tombstones: captureTombstones,
        // One derivation of cap + TTL, shared with the runtime gate and every
        // out-of-loop queue (`approvalLimits`).
        ...approvalLimits(config.memoryApproval),
        ...(evidenceSessions > 0 ? { evidenceSessions, autoPromote: !captureGated } : {}),
        // Cap drops must be audible (Curator lesson, plan §3b) — same seam as
        // the build-infrastructure write path.
        observability: {
          onCapExceeded: (info) => {
            log.warn(
              `memory pending queue at cap (${info.cap}) for ${info.scopeId} — dropped oldest candidate ${info.droppedId}`,
            );
            opts.observability?.recordMemoryPendingCapDrop({ details: { ...info } });
          },
        },
        apply: async (entry, approvedBy) => {
          const handle = withHistory(captureBase, captureHistory, {
            source: entry.source,
            approvedBy,
            // A promoted evidence entry records its hash like a direct capture
            // write does, so dedup keeps it from being queued a second time.
            ...(entry.evidenceSessions && entry.factHash
              ? { captureHashes: [entry.factHash] }
              : {}),
          });
          const ctx: MemoryContext = {
            scopeId: entry.scopeId,
            sessionId: entry.sessionId ?? '',
            sessionKey: entry.sessionKey ?? 'cli',
            platform: 'cli',
            workingDir: '',
          };
          await handle.sync([entry.update], ctx);
        },
      });
      capturePropose = async (proposal) => {
        await pending.propose(proposal);
      };
    }

    const captureRunner = new MemoryCaptureRunner({
      provider: captureBase,
      history: captureHistory,
      session,
      llm: captureLlm,
      sanitize,
      logger: log,
      nightlyConfigured,
      consolidate,
      tombstones: captureTombstones,
      ...(capturePropose ? { propose: capturePropose } : {}),
      // R8 — memory must not quietly record "I did a good job" from a turn its
      // own tools contradict. Absent when `grounding.enabled: false`, so an
      // opted-out deployment's capture path is byte-identical to today's.
      ...(toolsResult.memoryConsult ? { grounding: toolsResult.memoryConsult } : {}),
      config: {
        ...(captureConfig.maxPerHour !== undefined ? { maxPerHour: captureConfig.maxPerHour } : {}),
        ...(captureConfig.maxPerDay !== undefined ? { maxPerDay: captureConfig.maxPerDay } : {}),
      },
      workingDir: wiringCtx.dataDir,
    });
    captureRunner.registerHook(hooks);
    onMemoryCapturedFn = (cb) => captureRunner.onCaptured(cb);
    // Capture runs AFTER the turn's stream closes: an LLM pass, then writes to
    // memory / history / the pending queue. Both a stop and a `/model` switch
    // wait for one already in flight rather than dropping it (F06).
    captureIdle = () => captureRunner.whenIdle();
    disposers.push('memory capture', () => captureRunner.whenIdle());
  }

  // Real-time voice stack. Null (a clean no-op) unless `config.voice.*` is
  // configured. The SIP trunk and the LiveKit token minter now build themselves
  // from config inside `buildVoiceStack`; what still needs an app-supplied
  // binding is the room MEDIA client (`@livekit/rtc-node`), which callers pass
  // as `livekit.createClient` — absent, the transports degrade to unavailable
  // and everything else in the stack still works. `apps/ethos` supplies it from
  // `resolveLiveKitMedia()` when telephony is configured; nothing else does.
  const voiceStack = await buildVoiceStack({
    config,
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    ...(config.secretsResolver ? { secrets: config.secretsResolver } : {}),
    logger: log,
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.livekit ? { livekit: opts.livekit } : {}),
  });
  if (voiceStack) disposers.push('voice stack', () => voiceStack.close());

  return {
    loop,
    dispose: () => disposers.dispose(),
    drain: async () => {
      // Jobs first: a running job can start a goal run, never the reverse
      // once the executor has stopped claiming.
      await backgroundExecutor?.drain();
      await goalRunner.whenIdle();
      // Last: a capture queued by the turn that has just finished.
      await captureIdle?.();
    },
    toolRegistry: tools,
    // Lane 3(b) — the served window of the primary provider, exposed so
    // `ethos bench context` divides by the SAME denominator the schema-budget
    // warning uses (no second measurement path).
    contextWindow: llm.maxContextTokens,
    mcpManager,
    // The registry the tools resolved their backend from. `resolve()` memoises,
    // so handing this out is handing out the very instance `compose-tools`
    // built — which is the point: a Settings probe against a second registry
    // would answer about an object nothing runs on.
    executionBackends: infra.executionBackends,
    skillsInjector,
    setMessagingSend: (fn) => {
      ref.fn = fn;
    },
    setOnSkillProposed: (fn) => {
      onSkillProposedFn = fn;
    },
    ...(onMemoryCapturedFn ? { onMemoryCaptured: onMemoryCapturedFn } : {}),
    ...(approverDecision ? { approverDecision } : {}),
    ...(runCallCaptureFn ? { runCallCapture: runCallCaptureFn } : {}),
    notificationRouter,
    pluginLoader,
    // The runner above was built on THIS goalStore — the pair leaves together.
    goals: { store: goalStore, executor: goalRunner },
    memoryBundle,
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
    ...(jobRunnerRegistry ? { jobRunners: jobRunnerRegistry } : {}),
    ...(meshProxyReconciler ? { meshProxyReconciler } : {}),
    activePersonality: activePerson,
    // The loop's OWN registry (M-D13): a host that re-reads a declaration
    // between turns must read the one the turn runs against, not a second one
    // it built itself.
    personalities,
    refreshPersonalities: () => personalities.loadFromDirectory(join(dataDir, 'personalities')),
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    realtimeProviders: infra.realtimeProviders,
    ...(voiceStack ? { voiceStack } : {}),
    voiceConfig: {
      sttProviderName: config.auxiliaryAsr?.provider,
      sttProviderConfig: config.auxiliaryAsr
        ? {
            apiKey: config.auxiliaryAsr.apiKey,
            model: config.auxiliaryAsr.model,
            baseUrl: config.auxiliaryAsr.baseUrl,
            command: config.auxiliaryAsr.command,
            timeout: config.auxiliaryAsr.timeout,
          }
        : {},
      ttsProviderName: config.auxiliaryTts?.provider,
      ttsProviderConfig: config.auxiliaryTts
        ? {
            apiKey: config.auxiliaryTts.apiKey,
            model: config.auxiliaryTts.model,
            voice: config.auxiliaryTts.voice,
            baseUrl: config.auxiliaryTts.baseUrl,
            command: config.auxiliaryTts.command,
            outputFormat: config.auxiliaryTts.outputFormat,
            timeout: config.auxiliaryTts.timeout,
            maxTextLength: config.auxiliaryTts.maxTextLength,
          }
        : {},
      // The named rosters (`voice.tts.providers.*` / `voice.stt.providers.*`).
      // `auxiliary.tts` / `auxiliary.asr` above stay the default entries; these
      // are what a personality's `voice.tts_provider` / `voice.stt_provider` can
      // name instead.
      ...(config.voice?.tts?.providers ? { ttsRoster: config.voice.tts.providers } : {}),
      ...(config.voice?.stt?.providers ? { sttRoster: config.voice.stt.providers } : {}),
      // The realtime roster (`voice.realtime.providers.*`) plus the two keys
      // that decide whether the realtime tier runs at all: which entry a
      // personality that names none gets, and the deployment's tier default.
      ...(config.voice?.realtime?.providers
        ? { realtimeRoster: config.voice.realtime.providers }
        : {}),
      ...(config.voice?.realtime?.default
        ? { realtimeDefault: config.voice.realtime.default }
        : {}),
      ...(config.voice?.tier ? { tier: config.voice.tier } : {}),
      // The cap on ONE realtime call. Forwarded here rather than left to
      // web-api's live-config read alone — that read is optional, and a
      // deployment whose cap depends on an optional code path does not have a
      // cap, it has a coincidence.
      ...(config.voice?.realtime?.sessionBudgetUsd !== undefined
        ? { realtimeSessionBudgetUsd: config.voice.realtime.sessionBudgetUsd }
        : {}),
      secretsResolver:
        config.secretsResolver ?? (NOOP_SECRETS as import('@ethosagent/types').SecretsResolver),
      // Armed only when `voice.trustedPlugins` is declared. Computed once here
      // so every surface enforces the SAME allowlist instead of each deriving
      // its own notion of "trusted".
      ...(config.voice?.trustedPlugins
        ? { trustedVoicePlugins: new Set(config.voice.trustedPlugins) }
        : {}),
    },
  };
}
