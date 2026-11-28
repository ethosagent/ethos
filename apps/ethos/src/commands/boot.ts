// `ethos boot` — the merged single-process profile from
// plan/phases/single-process-boot-profile.md §6.
//
// WHY THIS EXISTS. Boot-time reconciliation is split across `ethos gateway
// start` and `ethos serve`, and each is missing work the other does (plan §1):
// `serve` never calls `sweepPendingDeliveries()` / `sweepUndeliveredJobs()`,
// `gateway` never calls `A2aTaskStore.failNonTerminal()`. In an always-on
// deployment that asymmetry is invisible; under scale-to-zero every wake is a
// boot, so whichever command is not running silently skips its half. This
// command runs BOTH roles' construction in ONE process and calls
// `runBootReconciliation()` (apps/ethos/src/boot-reconciliation.ts) once,
// explicitly, at the point in the sequence where every dependency it needs is
// live — closing the gap.
//
// ADDITIVE, NOT A REPLACEMENT (plan §2). `runGatewayStart` and `runServe` are
// unchanged and keep working exactly as they do today for existing
// multi-process deployments. This file only CALLS the named seams Phase 1
// extracted out of them; it does not modify either command's behavior.
//
// WHAT IT DELIBERATELY DOES NOT WIRE. This is the merged BOOT profile, not a
// merge of every optional subsystem the two commands can start. The following
// are reachable only from their own command today and are NOT constructed
// here; each is called out at its would-be position below:
//   • telephony / SIP inbound (`createSipInboundHandler` is still inline in
//     `runGatewayStart`; Phase 1 did not extract it)
//   • dreaming (`DreamExecutor`), the Langfuse export poller, the kanban poll
//     loop, team-supervisor spawning, and gateway quick-commands
// Everything reconciliation depends on IS wired. So is the idle watcher: this
// is the profile plan/phases/idle-watcher.md was written for, since a
// scale-to-zero deployment needs something to decide when suspending is safe.

import { join } from 'node:path';
import { AgentMesh, meshRegistryPath } from '@ethosagent/agent-mesh';
import {
  type EthosConfig,
  ethosCronDir,
  ethosDir,
  ethosScriptsDir,
  loadConfigStrict,
  type WebhookHookConfig,
} from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import {
  buildCronTriggers,
  CronScheduler,
  type CronTriggers,
  runScriptFile,
} from '@ethosagent/cron';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { IdleWatcherManager } from '@ethosagent/idle-watcher';
import { SQLiteInboundDedupStore } from '@ethosagent/inbound-dedup';
import { ConsoleLogger } from '@ethosagent/logger';
import { createMetricsTextProvider } from '@ethosagent/observability-sqlite';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteContextLog, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import Database from '@ethosagent/sqlite';
import { FsAttachmentCache, FsStorage } from '@ethosagent/storage-fs';
import { teamsDir } from '@ethosagent/team-supervisor';
import {
  EthosError,
  type InboundMessage,
  type NotificationRouter,
  type PlatformAdapter,
} from '@ethosagent/types';
import { WatcherManager, type WatcherWakeEvent } from '@ethosagent/watchers';
import { IdempotencyStore, resolveWebTokenEnv, WebTokenRepository } from '@ethosagent/web-api';
import {
  createLazyProvider,
  createOutboundPolicyGate,
  createSessionStore,
  IdentityMap,
  initPairingDb,
  type MessagingSendFn,
  privateChatSetFrom,
  SQLiteNotifyQueue,
  seedAllSystemJobs,
  systemJobProblem,
  targetAudience,
} from '@ethosagent/wiring';
import { runBootReconciliation } from '../boot-reconciliation';
import {
  type ClarifyCorrelator,
  closeIdleRouteListener,
  createClarifyCorrelatorRegistry,
  createLiveBotBusySource,
  replaceBotWiring,
  type WebBindTarget,
} from '../config-reload';
import {
  createEventLoopLagSampler,
  createHealthServer,
  createReadinessCheck,
} from '../health-server';
import { boundedShutdownStep } from '../lib/bounded-shutdown-step';
import { exitIfConfigInvalid } from '../lib/config-exit';
import { type CronDeliverJob, createCronDeliver } from '../lib/cron-deliver';
import { disposeBeforeExit } from '../lib/dispose-before-exit';
import {
  openInboundSpool,
  pruneInboundSpool,
  startInboundSpoolReplay,
  takeGatewayLockOrExit,
} from '../lib/gateway-inbound-durability';
import { scrubExpiredIncognito } from '../lib/incognito-retention';
import { bindInitiativeHostFor } from '../lib/initiative-wiring';
import { openShareLinks } from '../lib/open-share-links';
import {
  createOutboxApprovalSurface,
  createOutboxDispatcher,
  createOutboxReviewer,
  createOutboxRuntime,
  isOutboxCardCapable,
  loadOutboxCardRefs,
  OUTBOX_CARDS_FILE,
  type OutboxCardCapableAdapter,
  wireOutboxCardAdapters,
} from '../lib/outbox-wiring';
import { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';
import { pruneExpiredSessions } from '../lib/session-retention';
import { watcherWakeMessage } from '../lib/watcher-wake';
import { emitReady } from '../logger';
import { applyPauseCorrections, hasHeartbeatBump } from '../pause-corrections';
import { createPauseLifecycle } from '../pause-lifecycle';
import { createPlatformWebhookServer } from '../platform-webhook-server';
import { closeProcessPluginHostPool, openProcessPluginHostPool } from '../plugin-host-pool';
import { installProcessGuards } from '../process-guards';
import { notifyReady, startWatchdog } from '../sd-notify';
import { createWebhookServer, type PrefilterRunner } from '../webhook-server';
import {
  buildServeBusySources,
  buildSystemTaskHandlers,
  closeObservabilityStore,
  createAgentLoop,
  createLLM,
  dedupeBusySources,
  deriveIdleWatcherCapabilities,
  getEthosObservability,
  getFunnelTracker,
  getObservabilityStore,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import { startBootCallCapture } from './boot-callcapture';
import {
  ACP_PORT_DEFAULT,
  c,
  gatewayHealthPath,
  HEARTBEAT_INTERVAL_MS,
  WEB_PORT_FALLBACK_ATTEMPTS,
} from './boot-constants';
import { channelDigestFeed } from './boot-digest';
import { startConfigReload } from './boot-reload';
import { cronContextAudience, cronFiringAudience, runCronTurn } from './cron-turn';
import {
  adapterRegistries,
  buildBotSpeakers,
  buildChannelSpeakers,
  buildGateway,
  buildGatewayAdapters,
  buildGatewayBots,
  buildGatewayBusySources,
  buildGatewayHeartbeat,
  buildGatewayVoiceOutputs,
  buildPlatformWebhookMounts,
  channelDigestSystemTask,
  closeSlackSessionStores,
  createCapturingAdapter,
  createGatewayAttachmentCache,
  createGatewayMetricsAuthCheck,
  createTelegramGreetingProvider,
  createTelegramPersonalityCardReader,
  everyStartedAdapter,
  type GatewayBotWiring,
  gatewayHealthStatus,
  gatewayObservability,
  gatewaySqliteStorePaths,
  gatewayTurnOrigin,
  idleGatewayBotLoopOpts,
  loadRoomPolicies,
  openChannelTranscriptStore,
  registerGatewayClarifySurfaces,
  startAdaptersIsolated,
  validateBindings,
  warnEmailSenderAuthUnconfigured,
  warnRoomPolicies,
  wireApprovalFlow,
} from './gateway';
import {
  buildServeA2aCore,
  buildServeA2aSurface,
  buildServeAcpServer,
  buildServeWebApi,
  locateWebDist,
} from './serve';
import {
  parseFlagValue,
  parsePort,
  resolveAllowedOrigins,
  resolveCorsOrigins,
  resolveWebHost,
  resolveWebPort,
} from './serve-helpers';
import {
  closeListener,
  formatNonLoopbackNotice,
  isLoopbackHost,
  listenWithFallback,
} from './serve-listen';

export { channelDigestFeed } from './boot-digest';

/**
 * The merged boot profile. Construction order follows plan §3b step-for-step;
 * every deviation is called out inline.
 *
 * @param config — a PRESENCE CHECK ONLY; it is NOT the config that runs. The
 * CLI has already parsed `~/.ethos/config.yaml` leniently and passes the result
 * here so that a missing config becomes "run ethos setup first" below. The
 * config actually in force is `cfg` (`loaded.config`), from the STRICT re-load
 * a few lines down — `runGatewayStart` uses `loadConfigStrict` deliberately and
 * the gateway role this profile merges inherits that contract, so the file is
 * parsed twice on purpose. Below this point, read `cfg`; never `config`.
 */
export async function runBoot(args: string[], config: EthosConfig | null): Promise<void> {
  // -------------------------------------------------------------------------
  // §3b step 1 — shared config / storage / identity setup
  // -------------------------------------------------------------------------
  //
  // There is no onboarding branch here, unlike `runServe`: this profile merges
  // the GATEWAY role too, and the gateway role has no meaningful behaviour
  // without config (it exits on a missing one today). Run `ethos serve` for
  // the onboarding wizard, then `ethos boot`.
  if (config === null) {
    console.error('Run ethos setup first.');
    process.exit(1);
  }
  const storage = getStorage();
  const secrets = await getSecretsResolver();
  // The STRICT loader, matching the gateway role's contract: parse-time errors
  // (typos in bind.type, missing bot tokens) surface here rather than silently
  // booting zero bots. This deliberately re-parses the file the `config`
  // parameter above came from — that parameter is only the presence check, and
  // `loaded.config` is what every line below actually uses.
  const loaded = await loadConfigStrict(storage, secrets);
  if (!loaded) {
    console.error('Run ethos setup first.');
    process.exit(1);
  }
  exitIfConfigInvalid('Config parse errors', loaded.parseErrors);
  for (const note of loaded.deprecations) {
    console.log(`${c.yellow}⚠ deprecation${c.reset} ${c.dim}${note}${c.reset}`);
  }
  const cfg = loaded.config;
  // The process's one plugin host pool (plan plugin-process-isolation D4),
  // lent to every loop below by `createAgentLoop`; disposed in `shutdown` after
  // the loops that borrow it.
  await openProcessPluginHostPool(cfg, storage);
  const dir = ethosDir();

  // One gateway per state dir (plan reach-and-containment §2.7): this profile
  // owns platform adapters exactly as `ethos gateway start` does, so it takes
  // the SAME lock, here — after config load, BEFORE any store is opened or
  // adapter constructed. Held by a running gateway (or another boot) → the
  // refusal is printed and this exits 3, which `ethos run-all` and the desktop
  // app read as "already running". Released after the spool closes in
  // `shutdown`, and on process exit (`takeGatewayLockOrExit`).
  const releaseGatewayLock = await takeGatewayLockOrExit(dir);

  const bindErrors = await validateBindings(cfg);
  exitIfConfigInvalid('Bot binding errors', bindErrors);

  const acpPort = parsePort(parseFlagValue(args, ['--port']), ACP_PORT_DEFAULT);
  const webPort = resolveWebPort(args, process.env, cfg);
  const webHost = resolveWebHost(args, process.env, cfg);
  const corsOrigins = resolveCorsOrigins(process.env, cfg);
  const allowedOrigins = resolveAllowedOrigins(process.env);
  const trustProxy =
    process.env.ETHOS_TRUST_PROXY === '1' || process.env.ETHOS_TRUST_PROXY === 'true';
  const isLoopbackBind = isLoopbackHost(webHost);
  const healthPort = Number(process.env.ETHOS_GATEWAY_HEALTH_PORT) || 3002;
  const healthHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  const webhookPort = Number(process.env.ETHOS_WEBHOOK_PORT) || 3003;
  const webhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  // 3002 gateway health, 3003 gateway webhook, 3004 `ethos run-all` health, 3005
  // SIP — 3006 is next. Same default and env var `runGatewayStart` uses, so a
  // deployment that moves the port moves it for both entry points at once.
  const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;
  const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';

  console.log(
    `${c.bold}ethos boot${c.reset}  ${c.dim}starting (merged gateway + serve)...${c.reset}`,
  );

  const identityMap = new IdentityMap({ storage, dataDir: dir });
  const resolveUserId = (platform: string, platformUserId: string, displayLabel?: string) =>
    identityMap.resolve(platform, platformUserId, displayLabel);
  await identityMap.resolve('desktop', 'desktop', 'Desktop');

  // ONE session store and ONE personality registry for both roles — the merge
  // win the split process cannot have.
  const session = createSessionStore({
    dataDir: dir,
    ...(config.retention ? { retention: config.retention } : {}),
  });
  const contextLog = new SQLiteContextLog(join(dir, 'sessions.db'));
  const personalities = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: dir,
  });
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  try {
    personalities.setDefault(cfg.personality);
  } catch {
    // Configured default not on disk — keep the registry's built-in default.
  }
  const skillsCatalogDir = resolveSkillsCatalogDir(import.meta.dirname);
  const meshName = parseFlagValue(args, ['--mesh']) ?? 'default';
  const activePersonalityId = cfg.personality;

  // -------------------------------------------------------------------------
  // §3b step 3 (constructed here, STARTED at step 7) — watcher manager + cron
  // -------------------------------------------------------------------------
  //
  // Hoisted above `createAgentLoop` for the same reason both commands hoist
  // it: the loop registers the agent-callable `cron`/`watcher` tools against
  // these instances, and the scheduler's `runJob` forward-references the loop.
  const logger = new ConsoleLogger({}, cfg.logs?.level);
  let sharedLoop: AgentLoop | null = null;
  let chatServiceRef: import('@ethosagent/web-api').ChatService | null = null;
  let cronDeliverFn: ((job: CronDeliverJob, output: string) => Promise<void>) | null = null;
  let watcherDeliverFn:
    | ((target: { platform: string; chatId: string }, text: string) => Promise<void>)
    | null = null;
  // Resolves whether a turn was started — `false` costs the watcher no fire
  // (`WatcherManagerConfig.wake`).
  let watcherWakeFn: ((event: WatcherWakeEvent) => Promise<boolean>) | null = null;
  // Named so the SAME wake path drives both `WatcherManager` and the
  // call-capture daemon — one closure, not two copies (mirrors both commands).
  const watcherWake = async (event: WatcherWakeEvent): Promise<boolean> =>
    watcherWakeFn ? watcherWakeFn(event) : false;
  const watcherManager = new WatcherManager({
    storage,
    logger,
    // Judges a watcher's origin chat and delivery target for its wake
    // audience (`WatcherManager.wakeAudience`), honouring trusted rooms.
    targetAudience: (platform, chatId) =>
      targetAudience(platform, chatId, privateChatSetFrom(cfg.gateway?.privateChats)),
    deliver: async (target, text) => {
      if (watcherDeliverFn) await watcherDeliverFn(target, text);
    },
    wake: watcherWake,
    // The approval outbox's delivery-time hold (O-T12): one gate per manager,
    // in place before the first tick rather than late-bound by whichever loop
    // is composed last. The policy is looked up on every delivery, after
    // `reload` brings the registry up to date — a tick is not a turn, so
    // `personalityDirectory.refresh()` has not run.
    deliveryGate: createOutboundPolicyGate({
      lookupPersonality: (id) => personalities.get(id),
      ownerTarget: (platform) => cfg.channelFilter?.[platform]?.ownerUserId,
      reload: () => personalities.loadFromDirectory(join(dir, 'personalities')),
    }),
  });
  const scheduler = new CronScheduler({
    storage,
    cronDir: ethosCronDir(),
    scriptsDir: ethosScriptsDir(),
    // A shared firing reads only shared `contextFrom` output (E1).
    runAudience: cronContextAudience(privateChatSetFrom(cfg.gateway?.privateChats)),
    logger,
    ...(cfg.cron?.defaultMaxRunMs !== undefined
      ? { defaultMaxRunMs: cfg.cron.defaultMaxRunMs }
      : {}),
    ...(cfg.cron?.maxParallelJobs !== undefined
      ? { maxParallelJobs: cfg.cron.maxParallelJobs }
      : {}),
    executionBackend: new LocalExecutionBackend({ config: {}, secrets, logger }),
    systemTasks: {
      ...buildSystemTaskHandlers(cfg),
      ...watcherManager.systemTasks(),
      // See `channelDigestSystemTask` — the digest needs the live Gateway, so
      // it cannot come from the shared handler table. Forward-referenced
      // through `gatewayRef`, which is set before cron starts.
      // `inAppSink: true` — this profile has a web API, so `deliverTo: 'inApp'`
      // has somewhere to land. See `channelDigestFeed` (./boot-digest).
      'channel-digest': channelDigestSystemTask(cfg, () => gatewayRef, { inAppSink: true }),
    },
    onDecision: (job, d) => {
      try {
        getEthosObservability().recordHeartbeatDecision({
          personalityId: job.personalityId,
          jobId: job.id,
          decision: d.action,
          delivered: d.delivered,
        });
      } catch {
        // observability unavailable — audit is fail-open
      }
    },
    // Gateway-role delivery: an origin-bearing job routes its output back to
    // the channel it was created from. `ethos serve` alone cannot do this.
    deliver: async (job, output) => {
      if (cronDeliverFn) await cronDeliverFn(job, output);
    },
    // Serve-role turn shape (`runCronTurn`): reuses a web-origin session when
    // the personality matches, which the gateway's `createCronRunJob` does not.
    runJob: async (job, runOpts) => {
      const loop = sharedLoop;
      if (!loop) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: 'System loop not yet initialised at cron firing time',
          action:
            'This is a wiring bug — the scheduler started before the agent loop was assigned. File an issue.',
        });
      }
      await personalities.loadFromDirectory(join(dir, 'personalities'));
      const pers = personalities.get(job.personalityId);
      // Recursion guard: a cron-spawned session cannot schedule further jobs.
      const toolsetOverride = pers?.toolset?.filter((t: string) => t !== 'cron');
      const webOrigin =
        job.origin?.platform === 'web' && job.origin.chatId ? job.origin.chatId : null;
      const ranAt = new Date().toISOString();
      const { sessionKey, output, transcript, reusedWebOrigin, progress } = await runCronTurn({
        loop,
        sessions: session,
        jobId: job.id,
        prompt: job.prompt ?? '',
        personalityId: job.personalityId,
        webOrigin,
        roomAudience: await cronFiringAudience(job, {
          listJobs: () => scheduler.listJobs(),
          privateChats: privateChatSetFrom(cfg.gateway?.privateChats),
          warn: (line) => logger.warn(line),
        }),
        ...(toolsetOverride ? { toolsetOverride } : {}),
        // R10 — the scheduler aborts this at the job's `maxRunMs`.
        ...(runOpts ? { abortSignal: runOpts.abortSignal } : {}),
      });
      chatServiceRef?.broadcastAll({
        type: 'cron.fired',
        jobId: job.id,
        ranAt,
        outputPath: null,
        ...(reusedWebOrigin && webOrigin ? { sessionKey: webOrigin } : {}),
      });
      return {
        jobId: job.id,
        ranAt,
        output,
        sessionKey,
        progress,
        ...(transcript !== undefined ? { transcript } : {}),
      };
    },
  });
  watcherManager.attachScheduler(scheduler);
  // `boot` threads `cronTriggers` into the shared serve-role helper below, so
  // it inherits serve's `POST /cron/fire` mount and must answer the same way:
  // `hasHttpSurface: true` means a `cron.fireUrl` genuinely stops the
  // in-process interval here (plan/phases/cron-fire-url-collapse.md, D1).
  const cronTriggers: CronTriggers = buildCronTriggers(scheduler, cfg.cron, {
    hasHttpSurface: true,
  });
  for (const notice of cronTriggers.notices) {
    console.log(`${c.yellow}⚠${c.reset} ${c.dim}${notice}${c.reset}`);
  }
  scheduler.setArmingBackend(cronTriggers.arming);

  // -------------------------------------------------------------------------
  // §3b step 2 — `createAgentLoop`, EXACTLY ONCE (plan §3c / §11 OQ1)
  // -------------------------------------------------------------------------
  //
  // ONE SYSTEM `AgentLoop`, with ONE `BackgroundExecutor` and ONE
  // `SQLiteJobStore`, shared by the gateway role and the serve role. Two would
  // be wasteful but not racy on the store itself (every mutation is a CAS in a
  // transaction, owner strings are unique per executor) — the REAL hazard is
  // SUBSCRIPTION: `onComplete` / `onRunUpdate` are in-memory per-instance
  // subscriber lists (packages/wiring/src/build-agent-loop.ts), so a job
  // claimed by a gateway-role executor would never fire the serve-role
  // executor's `subscribeJobComplete` / `subscribeRunUpdates` — the exact seams
  // web-api's run card and completion hand-back use. Hence one SYSTEM loop.
  //
  // WHAT THIS DOES NOT MAKE SINGLE: the per-bot loops. `buildGatewayBots` below
  // still gives every personality-bound bot its OWN `jobStore` +
  // `backgroundExecutor` (which is exactly the set `buildGatewayBusySources`
  // folds over), so the same per-instance subscriber hazard still stands
  // between a per-bot executor and web-api's subscribers: a job claimed by a
  // bot's executor does not reach them. That is inherited verbatim from
  // `ethos gateway start` and is NOT closed by this profile.
  // The approval outbox (Part 2, plan/phases/trust-before-reach.md). Opened
  // AHEAD of every loop: each one's `send_message` gate is built from it, so a
  // personality whose `outbound_policy.approve_before_send` is on queues its
  // publications instead of sending them. ONE module, shared with
  // `ethos gateway start` — see `../lib/outbox-wiring` and O-D8.
  //
  // `personalities` is the registry `personalityDirectory.refresh()` reloads,
  // so an edited `approver_personality` applies on the next call rather than
  // the next restart.
  const botSpeakers = buildBotSpeakers(cfg);
  // O-T7/O-T8. The approval surface's seams — the system loop the review turn
  // runs on, the adapter that DMs the card — are built further down, so it is
  // constructed right after the runtime (whose proposal hook needs it) and
  // reads them late. ONE module with `ethos gateway start`, for O-D8's reason.
  // O-T8 — the card adapter for each bot, filled by `registerBotLive` below so
  // a bot added by a config reload gets its approval cards without a restart.
  const outboxCardAdapters = new Map<string, OutboxCardCapableAdapter>();
  const outbox = createOutboxRuntime({
    speakers: botSpeakers,
    // X-D11 — every human outbox decision lands in `ethos audit decisions`,
    // next to the tool approvals `wireApprovalFlow` records through this same
    // sink. Resolved LAZILY, for that flow's reason: a boot that never settles
    // an approval never opens the observability DB. `OutboxService.audit` is
    // fail-open, so a broken sink costs an audit row, never a decision.
    observability: {
      recordSafetyApproval: (opts) => getEthosObservability().recordSafetyApproval(opts),
    },
    ownerTarget: (platform) => cfg.channelFilter?.[platform]?.ownerUserId,
    approverFor: (personalityId) =>
      personalities.get(personalityId)?.outbound_policy?.approver_personality,
    // Fire-and-forget: the item IS queued, so a review or a card that fails
    // costs the operator a Telegram convenience, never the publication.
    onProposed: (item, created) => outboxSurface.proposed(item, created),
    logger,
  });

  // The durable card map (`~/.ethos/outbox-cards.json`). `OutboxItem` has no
  // card columns, and without this a restart between a tap and a delivery
  // leaves the operator's card reading "Approved — sending…" for good.
  const outboxSurface = createOutboxApprovalSurface({
    service: outbox.service,
    reviewer: createOutboxReviewer({
      service: outbox.service,
      // The SAME loop cron fires on in this profile.
      loop: () => sharedLoop,
      hasPersonality: (id) => personalities.get(id) != null,
      logger,
    }),
    adapterFor: (botKey, platform) => {
      const adapter = outboxCardAdapters.get(botKey);
      // Never a sibling bot on the same platform: the card is DM'd by the
      // account whose name is on it (the F08 rule, on the approval side).
      return adapter?.id.startsWith(`${platform}:`) ? adapter : undefined;
    },
    ownerTarget: (platform) => cfg.channelFilter?.[platform]?.ownerUserId,
    cardRefs: await loadOutboxCardRefs(storage, join(dir, OUTBOX_CARDS_FILE), logger),
    logger,
  });

  // Per-bot routing table. Each personality-bound bot gets its own loop, the
  // same shape `ethos gateway start` builds today — this is NOT the
  // double-construction §3c warns about, which is about the two ROLES each
  // building a system loop. Built BEFORE the system loop only so that loop
  // knows whether it is also the idle gateway bot's (below); neither build
  // reads the other.
  const coldBuilt = await buildGatewayBots(
    cfg,
    scheduler,
    watcherManager,
    gatewayTurnOrigin(() => gatewayRef),
    undefined,
    outbox.wiring,
  );
  const bots = coldBuilt.bots;

  const shared = await createAgentLoop(cfg, {
    profile: 'web',
    meshRegistryPath: meshRegistryPath(meshName),
    cronScheduler: scheduler,
    watcherManager,
    // Cron, watcher wakes and every web/ACP turn run here, and a gated
    // personality's `send_message` must queue from this loop exactly as it
    // does from a bot's.
    outbox: outbox.wiring,
    // No bot configured: this loop is also the idle gateway bot's (`idleGatewayBotLoopOpts`); `originBotKey` wins in `resolveJobAffinity`.
    jobAffinity: 'boot',
    ...(bots.length === 0 ? idleGatewayBotLoopOpts(gatewayTurnOrigin(() => gatewayRef)) : {}),
  });
  sharedLoop = shared.loop;
  // Deliberately NOT given `wireUnattendedApprovalGate` (which `runGatewayStart`
  // registers on its systemLoop): here cron and watcher wakes share the web
  // loop, and `buildServeWebApi` registers the web approval hook on it, so a
  // flagged call posts a modal card a human can answer (denied at the approval
  // timeout) — the same shape as `ethos serve`. The unattended gate would
  // refuse every flagged web-chat call too. Boot runs no dreams and no SIP.
  // That web hook's predicate (`buildServeDangerPredicate`, ./serve) never
  // takes the D12 opt-in, so with no bot configured the idle gateway bot's
  // channel turns (remote senders) on this loop cannot be auto-approved by
  // `allowUnattendedDangerousTools` either. Pinned by
  // `./__tests__/gateway-unattended-gate-wiring.test.ts` ('ethos boot').
  const systemLoop = shared.loop;

  // Personality-directory seam for hot-reload, shared by the Gateway and by
  // every loop registry in the process.
  //
  // Seeded with the SYSTEM loop's refresher only. Each bot's own refresher is
  // pushed by its `registerBotLive` call below — cold-booted and hot-added bots
  // alike — so a bot that leaves takes its refresher with it. The resulting
  // order is `[system, ...bots]`, exactly what the bulk seed produced.
  const personalityRefreshers = [shared.refreshPersonalities];
  const REFRESH_DEBOUNCE_MS = 300;
  let lastRefreshMs = 0;
  const personalityDirectory = {
    refresh: async (): Promise<void> => {
      const now = Date.now();
      if (now - lastRefreshMs < REFRESH_DEBOUNCE_MS) return;
      lastRefreshMs = now;
      const results = await Promise.allSettled([
        personalities.loadFromDirectory(join(dir, 'personalities')),
        ...personalityRefreshers.map((fn) => fn()),
      ]);
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(
          `[boot] personality refresh: ${failed}/${results.length} registries failed to reload (serving last-good)`,
        );
      }
    },
    has: (id: string): boolean => personalities.get(id) != null,
    voice: (id: string) => personalities.get(id)?.voice,
    // Channel presence (plan personality-presence-and-initiative §3) — same
    // seam and shape as `runGatewayStart`'s.
    identity: (id: string) => {
      const p = personalities.get(id);
      return p
        ? { name: p.name, ...(p.display?.emoji ? { emoji: p.display.emoji } : {}) }
        : undefined;
    },
    list: (): Array<{ id: string; name: string; isDefault: boolean }> => {
      const defaultId = personalities.getDefault().id;
      return personalities.list().map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.id === defaultId,
      }));
    },
  };

  // -------------------------------------------------------------------------
  // §3b step 4 — serve-role stack (constructed; NOTHING binds a port here)
  // -------------------------------------------------------------------------
  const mesh = new AgentMesh(meshRegistryPath(meshName), { storage });
  // §11 OQ8 — the ACP server is CONSTRUCTED here and `startHttp()` is deferred
  // to step 10, AFTER reconciliation. This diverges from `serve.ts`, whose
  // comment "kept first so any breakage is obvious" binds ACP before anything
  // else. That rationale is a DEBUGGABILITY argument and it belongs to
  // `serve.ts`, which keeps its ordering unchanged. `boot.ts` is a new command
  // with no legacy to preserve, so it follows §3b step 10's CORRECTNESS
  // principle instead: nothing external reaches a half-reconciled process.
  const acpServer = buildServeAcpServer({
    loop: systemLoop,
    session,
    mesh,
    personalities,
    activePersonality: activePersonalityId,
    teamFlag: undefined,
    mcpManager: shared.mcpManager,
    jobStore: shared.jobStore,
    backgroundExecutor: shared.backgroundExecutor,
    teamAuthToken: undefined,
  });

  const a2a = await buildServeA2aCore({
    config: cfg,
    dir,
    loop: systemLoop,
    personalities,
    activePersonality: activePersonalityId,
  });
  const {
    routeModules: a2aRouteModules,
    peering: a2aPeering,
    setA2aEnabled,
  } = buildServeA2aSurface({
    config: cfg,
    core: a2a,
    toolRegistry: shared.toolRegistry,
    trustProxy,
  });

  const apiKeys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
  const shareLinks = openShareLinks(dir, webHost, webPort);
  const idempotencyStore = new IdempotencyStore(join(dir, 'sessions.db'));
  const serveAttachmentCache = new FsAttachmentCache(
    new FsStorage(),
    join(dir, 'cache', 'attachments'),
  );
  void serveAttachmentCache.pruneOlderThan(24 * 60 * 60 * 1000).catch(() => {});
  const webDist = locateWebDist(parseFlagValue(args, ['--web-dist']));

  let titleFn: ((systemPrompt: string, userMessage: string) => Promise<string>) | undefined;
  try {
    // A session title is a model call outside any turn's own stream — metered
    // as `title` (background-usage-accounting §5.4).
    const titleLlm = shared.usageMeter.meter(await createLLM(cfg), 'title');
    titleFn = async (systemPrompt: string, userMessage: string): Promise<string> => {
      let text = '';
      for await (const chunk of titleLlm.complete([{ role: 'user', content: userMessage }], [], {
        system: systemPrompt,
        maxTokens: 64,
      })) {
        if (chunk.type === 'text_delta') text += chunk.text;
      }
      return text.trim();
    };
  } catch (err) {
    console.warn('[boot] session auto-title disabled: failed to create title LLM:', err);
  }

  // `ethos_gateway_adapter_up` reads LIVE adapter health — in the merged
  // process THIS process is the gateway, so there is no heartbeat file to read
  // through a staleness gate (which is what `serve.ts` has to do). Assigned
  // after the adapters exist; the closure is stable.
  let heartbeatStartedAt = new Date().toISOString();
  const metricsText = createMetricsTextProvider({
    store: getObservabilityStore(),
    getGatewayAdapters: async () => {
      // Read LIVE, not from a one-time snapshot: a bot hot-added or removed by
      // the config reconciler below must be reflected here on the very next
      // scrape (plan/phases/gateway-live-reload.md §2).
      const hb = await buildGatewayHeartbeat(gatewayRef?.listAdapters() ?? [], heartbeatStartedAt);
      return hb.adapters.map((a) => ({ adapter: a.name, up: a.ok ? 1 : 0 }) as const);
    },
  });
  // P2-counters — ethos_http_requests_total. Same closure shape as serve.ts.
  const recordHttpRequest = (method: string, status: number): void => {
    getObservabilityStore().recordHttpRequest(method, status);
  };

  // §3b step 6 — the web API. Its own SSE clarify presenter is registered
  // INSIDE `createWebApi`, and its `ClarifyBridge.hydrate()`/`.sweep()` fire
  // there too (apps/web-api/src/index.ts), which is why step 4 and step 6 of
  // the plan are one call here.
  const created = buildServeWebApi({
    config: cfg,
    dir,
    loop: systemLoop,
    // The smart approver's decision site from the build `systemLoop` came from
    // (plan decision-provider-jev §8.2), as `ethos serve` passes its own.
    ...(shared.approverDecision ? { approverDecision: shared.approverDecision } : {}),
    executionPostureFor: shared.executionPostureFor,
    usageMeter: shared.usageMeter,
    session,
    contextLog,
    personalities,
    identityMap,
    attachmentCache: serveAttachmentCache,
    apiKeys,
    shareLinks: shareLinks.host,
    idempotencyStore,
    toolRegistry: shared.toolRegistry,
    mcpManager: shared.mcpManager,
    pluginLoader: shared.pluginLoader,
    notificationRouter: shared.notificationRouter,
    cronScheduler: scheduler,
    cronTriggers,
    goals: shared.goals,
    initiativeEnablement: shared.initiativeRuntime.enablement,
    memoryBundle: shared.memoryBundle,
    amendments: shared.amendments,
    jobStore: shared.jobStore,
    jobRunners: shared.jobRunners,
    jobControl: shared.jobControl,
    backgroundExecutor: shared.backgroundExecutor,
    setOnSkillProposed: shared.setOnSkillProposed,
    onMemoryCaptured: shared.onMemoryCaptured,
    refreshLoopPersonalities: shared.refreshPersonalities,
    skillsInjector: shared.skillsInjector,
    // Settings › Execution probe — the SYSTEM loop's own registry, so the
    // instance it probes is the one that executes (`resolve()` memoises).
    executionBackends: shared.executionBackends,
    skillsCatalogDir,
    sttProviders: shared.sttProviders,
    ttsProviders: shared.ttsProviders,
    realtimeProviders: shared.realtimeProviders,
    voiceConfig: shared.voiceConfig,
    voiceStack: shared.voiceStack,
    titleFn,
    corsOrigins,
    allowedOrigins,
    trustProxy,
    isLoopbackBind,
    webDist,
    metricsText,
    recordHttpRequest,
    a2aRouteModules,
    a2aPeering,
    isA2aEnabled: a2a.isA2aEnabled,
    setA2aEnabled,
  });
  chatServiceRef = created.chatService;

  // -------------------------------------------------------------------------
  // §3b step 5 — gateway-role stack (constructed; adapters NOT started)
  // -------------------------------------------------------------------------
  const { attachmentCache, pruneTimer } = await createGatewayAttachmentCache(storage);
  // Loaded BEFORE the adapters: each gets its `roomModeDefault` from it (plan channel-prompts L12).
  const { table: roomPolicies, warnings: roomWarnings } = await loadRoomPolicies(storage, cfg);
  warnRoomPolicies(roomWarnings);
  const adapters = await buildGatewayAdapters(cfg, attachmentCache, roomPolicies);
  warnEmailSenderAuthUnconfigured(cfg);

  let gatewayRef: ReturnType<typeof buildGateway> | null = null;
  // Clarify correlators, LIVE and KEYED BY BOT. `registerGatewayClarifySurfaces`
  // returns a correlator covering only the adapters it was handed, so a
  // hot-added bot's surface is registered alongside the boot-time one rather
  // than replacing it — and, because the registry is keyed, a removed bot's
  // correlator is dropped instead of accumulating over a dead adapter, and a
  // re-added bot replaces its own. See `createClarifyCorrelatorRegistry` for
  // why the cold-boot correlator gets a slot of its own and runs last.
  //
  // DELIBERATE DIVERGENCE from `runGatewayStart`, which still passes the
  // possibly-undefined correlator straight through (and whose test asserts it
  // is omitted rather than always returning null). That rule was written when
  // the surface list was frozen at boot; here it is not, so "no correlating
  // surface at construction" no longer means "none ever" — a Telegram or
  // WhatsApp bot added live must be able to resolve its own force-replies.
  // The cost when the list is empty is one pure `isSenderAllowed` check.
  const clarifyCorrelators = createClarifyCorrelatorRegistry();
  // `typeof bots` rather than an imported `GatewayBotConfig`: only
  // `commands/gateway.ts` may import `@ethosagent/gateway` (daemon-free
  // doctrine, `daemon-free-smoke.test.ts`).
  //
  // ALWAYS per bot — there is no bulk cold-boot call. Each platform's surface
  // builder filters the adapter list by its own `<platform>:` prefix first, so
  // a one-bot slice builds that bot's surface and nothing else. Returns what it
  // registered so the caller's teardown can delete exactly its own correlator
  // and never one that has since replaced it.
  const registerClarifySurfacesFor = async (
    botsSlice: typeof bots,
    adaptersSlice: PlatformAdapter[],
    botKey: string,
  ): Promise<ClarifyCorrelator | undefined> => {
    const registered = await registerGatewayClarifySurfaces({
      bots: botsSlice,
      adapters: adaptersSlice,
      systemLoop,
      resolveApprovalRoute: (sessionId) => gatewayRef?.resolveApprovalRoute(sessionId),
    });
    const correlate = registered.clarifyMessageCorrelator;
    if (!correlate) return undefined;
    clarifyCorrelators.set(botKey, correlate);
    return correlate;
  };
  const clarifyMessageCorrelator = clarifyCorrelators.correlate;

  // Chapter 1 safety: fail closed if a channel adapter is configured without a
  // channel filter. Identical to `runGatewayStart`'s gate — a merged process
  // must not be a way to bypass it.
  if (adapters.length > 0 && !cfg.channelFilter) {
    console.error(
      `${c.red}FATAL: Channel adapters configured without channel_filter safety config.${c.reset}\n` +
        'Add channel_filter.<platform>.ownerUserId to config.yaml for each platform.',
    );
    process.exit(1);
  }
  for (const adapter of adapters) {
    const platform = adapter.id.includes(':') ? adapter.id.split(':')[0] : adapter.id;
    if (cfg.channelFilter && platform && !cfg.channelFilter[platform]) {
      console.error(
        `${c.red}FATAL: Adapter "${adapter.id}" has no channel_filter.${platform} config.${c.reset}`,
      );
      process.exit(1);
    }
  }

  let pairingDb: InstanceType<typeof Database> | undefined;
  if (cfg.channelFilter) {
    pairingDb = new Database(join(dir, 'pairing.db'));
    pairingDb.pragma('journal_mode = WAL');
    initPairingDb(pairingDb);
  }

  const deliveryLedger = new SQLiteDeliveryLedger(join(dir, 'delivery-ledger.db'));
  // U11 — notices held for quiet hours or a lane /mute (`held_notices`).
  const heldNotices = new SQLiteNotifyQueue(join(dir, 'notify-queue.db'));
  const inboundDedup = new SQLiteInboundDedupStore(join(dir, 'inbound-dedup.db'));
  // Inbound spool (plan reach-and-containment §2.2): the write-ahead record of
  // every turn this process owes, replayed after a crash. Only AFTER the
  // gateway lock above, which is what makes its boot-time orphan recovery safe.
  const { inboundSpool, inboundSpoolOptions } = openInboundSpool(cfg, dir);

  // Observe-mode transcript sink (plan/phases/ambient-group-monitoring.md R1).
  // Deliberately NOT eager like the two stores above: this one is opened on
  // first write, so `channel-transcript.db` appears only once a chat is
  // actually being watched. See `openChannelTranscriptStore`.
  const channelTranscript = openChannelTranscriptStore(join(dir, 'channel-transcript.db'));

  // Every adapter, keyed by the botKey it speaks as — the SAME derivation
  // `buildGateway` hands the Gateway (`adapterRegistries`), so the per-bot
  // lookup below finds Email under its declared botKey rather than its bare
  // `'email'` id.
  const { botAdapters: botAdapterMap } = adapterRegistries(adapters);

  // Filled by the per-bot `registerBotLive` calls below (bots first, in
  // registration order), then closed with the shared loop's router — the same
  // `[...bots, shared]` order the bulk seed produced, which `route()` below
  // depends on: it delegates to element 0.
  const allNotificationRouters: NotificationRouter[] = [];
  const gatewayNotificationRouter: NotificationRouter = {
    route: (pluginId, opts) =>
      allNotificationRouters[0]?.route(pluginId, opts) ?? Promise.resolve(),
    register: (sessionKey, adapter) => {
      for (const r of allNotificationRouters) r.register(sessionKey, adapter);
    },
    deregister: (sessionKey) => {
      for (const r of allNotificationRouters) r.deregister(sessionKey);
    },
  };

  const hasTelegram = adapters.some((a) => a.id.startsWith('telegram:'));
  const telegramCardReader = hasTelegram ? await createTelegramPersonalityCardReader() : undefined;
  const telegramGreetingProvider = hasTelegram ? await createTelegramGreetingProvider() : undefined;

  const streamingMode = cfg.displayStreamingEdits ?? 'dms';
  const voiceOutputs = buildGatewayVoiceOutputs(cfg, storage);

  const gateway = buildGateway({
    config: cfg,
    roomPolicies,
    bots,
    systemLoop,
    idleBotJobs: {
      jobStore: shared.jobStore,
      backgroundExecutor: shared.backgroundExecutor,
      jobControl: shared.jobControl,
    },
    adapters,
    deliveryLedger,
    inboundDedup,
    heldNotices,
    inboundSpool,
    inboundSpoolOptions,
    resolveUserId,
    pluginLoader: shared.pluginLoader,
    trustedChannelPlugins: shared.activePersonality?.plugins
      ? new Set(shared.activePersonality.plugins)
      : undefined,
    notificationRouter: gatewayNotificationRouter,
    storage,
    attachmentCache,
    sttProviders: shared.sttProviders,
    ttsProviders: shared.ttsProviders,
    voiceConfig: shared.voiceConfig,
    voiceModeStore: voiceOutputs.voiceModeStore,
    voiceArtifacts: voiceOutputs.voiceArtifacts,
    transcoder: voiceOutputs.transcoder,
    channelVoiceOut: voiceOutputs.channelVoiceOut,
    voiceBitrateKbps: voiceOutputs.voiceBitrateKbps,
    personalityDirectory,
    onTurnComplete: ({ platform }: { platform: string }) => {
      const funnel = getFunnelTracker();
      void funnel.recordFirstReply();
      void funnel.recordChannelFirstReply(platform);
    },
    // Dreaming is not wired in this profile (see the file header), so there is
    // no `DreamExecutor` to stamp user activity on.
    onUserTurn: undefined,
    streamingEdits: { dm: streamingMode !== 'off', group: streamingMode === 'all' },
    pairingDb,
    channelTranscript,
    channelDigestFeed: channelDigestFeed(created.notifyChannelDigest),
    clarifyMessageCorrelator,
    personalityCardReader: telegramCardReader,
    greetingProvider: telegramGreetingProvider,
    // O-T5's binding re-check, at bot granularity. The SAME roster the outbox's
    // sender resolver picked from, so "which bot may publish for this
    // personality" has one answer at propose time and at delivery time.
    publicationSpeaksFor: botSpeakers.speaksFor,
    // Every `gateway.*` event, into this process's observability store.
    observability: gatewayObservability(),
  });
  gatewayRef = gateway;
  // The durable lane → session map (plan openclaw-9.5-adoption D28), loaded
  // BEFORE any adapter is wired or started and before `startInboundSpoolReplay`
  // below (§3b): a replayed row, an interrupted `retry` and a `wake_review` turn all
  // resolve `sessionKeys`, and an empty map would run them in the lane's
  // default session instead of the one `/new` / `/fork` / `/branch` left it on.
  await gateway.restoreLaneSessions();

  // Wire the send paths now that the Gateway exists.
  //
  // `sendAsBot`, not `sendTo` (B-T4): the tool call comes out of a turn, and a
  // turn on a channel lane names the bot it speaks as. `sendTo` would resolve
  // the platform's FIRST adapter, so with two Telegram bots configured one
  // agent's `send_message` leaves through the other's identity.
  const gatewayMessagingSend: MessagingSendFn = async (platform, target, body, botKey) =>
    gateway.sendAsBot(platform, target, body, botKey);
  shared.setMessagingSend(gatewayMessagingSend);
  // Per-bot messaging setters are called by `registerBotLive` below, with every
  // other per-bot registration.
  //
  // The SAME cron delivery path `ethos gateway start` runs (B-T5): a job whose
  // bot left config delivers nothing, and a failed send throws so the scheduler
  // records `lastError`. This used to be a second, shorter copy that did
  // neither.
  cronDeliverFn = createCronDeliver({ gateway, speaksFor: buildChannelSpeakers(cfg) });
  const wireInitiative = bindInitiativeHostFor(gateway, cfg, adapters); // Task 6.5
  watcherDeliverFn = async (target, text) => {
    await gateway.sendTo(target.platform, target.chatId, text);
  };
  // Gateway-role wake: synthesize an `InboundMessage` into the owning
  // personality's lane so the woken turn has a real routing table and delivery
  // path. This strictly DOMINATES `serve.ts`'s wake, which drains the stream
  // with no surface consuming it — which is also why the single
  // `CallCaptureOwnershipManager` below is gateway-role (§11 OQ11).
  watcherWakeFn = async (event) => {
    const bot = bots.find(
      (b) => b.binding.type === 'personality' && b.binding.name === event.personalityId,
    );
    if (!bot) {
      console.error(
        `[watcher] wake dropped for "${event.watcherId}" — no bot bound to personality "${event.personalityId}"`,
      );
      return false;
    }
    // A shared wake carries `audienceHint: 'shared'` (`watcherWakeMessage`).
    const msg = watcherWakeMessage(event, bot.botKey);
    const { adapter } = createCapturingAdapter();
    await gateway.handleMessage(msg, adapter);
    return true;
  };

  for (const adapter of adapters) {
    adapter.onMessage((message: InboundMessage) => {
      void gateway.handleMessage(message, adapter).catch((err) => {
        console.error(`[boot:${adapter.id}] Error:`, err);
      });
    });
  }

  const approvalSeams = {
    personalities,
    getProvider: createLazyProvider(() => createLLM(cfg)),
    model: cfg.model,
    ...(cfg.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: cfg.approvalTimeoutMs } : {}),
    // The boot config's filter is the one installed in the Gateway (it is
    // construction-time; see `prepareBotLive`), so the owner deciding group
    // approvals is the same owner the gateway's `/personality` check reads.
    ownerFor: (platform: string) => cfg.channelFilter?.[platform]?.ownerUserId,
    // Where each personality's shell tools run (S6 / D1(a)) — the shared
    // build's, for the same reason as the decision site below.
    executionPostureFor: shared.executionPostureFor,
    usageMeter: shared.usageMeter,
    // The provider half of `decisions.*` is operator-level, so every bot's
    // approval predicate takes the shared build's decision site (plan
    // decision-provider-jev §8.2), as it takes that config's `createLLM(cfg)`
    // / `cfg.model` for the reviewer. The site's mode is still resolved per
    // call from the session's personality (plan decision-provider-personality §7.3).
    ...(shared.approverDecision ? { decision: shared.approverDecision } : {}),
  };
  /**
   * One approval surface per bot, keyed by botKey. `wireApprovalFlow` binds its
   * hook to the bots it was handed, so a bot that arrives live needs its own
   * call — and a bot that LEAVES needs its own shutdown, which a single bulk
   * flow could not give it. Cold-booted bots go through the same per-bot call
   * for that reason, not for symmetry's sake: replacing one of them used to
   * leave its approval surface bound to a retired loop forever.
   */
  const approvalFlows = new Map<string, ReturnType<typeof wireApprovalFlow>>();

  /**
   * Every live bot's app-level teardown handle, keyed by botKey — cold-booted
   * and hot-added alike. See {@link replaceBotWiring} for why there is exactly
   * one registry rather than a "hot bots only" one.
   *
   * The transport half — route unmount, deregister, adapter stop — is
   * `retireBotTransport`, deliberately kept separate: a swap retires the old
   * transport while the old wiring is still the thing a rollback must displace.
   */
  const botWiring = new Map<string, () => Promise<void>>();

  /**
   * F06 — the loop runtimes of every bot currently wired, cold-booted and
   * hot-added alike, keyed by identity (a swap briefly holds two loops for one
   * botKey). A bot's loop is released by its own wiring teardown — the step
   * that already runs exactly when nothing routes to it any more — and
   * whatever is still here at shutdown is released there. Each release is
   * `CreateAgentLoopResult.dispose`, which is idempotent, so a path that
   * releases the same bot twice (a failed commit after its rollback) is safe.
   */
  const liveBotLoops = new Set<() => Promise<void>>();
  // Declared before `releaseBotLoops` can run: a cold-booted bot whose
  // registration throws releases its loops right away, and a dispose that
  // rejects there formats its error with this. Declared later, that call threw
  // a TDZ ReferenceError and hid the registration error
  // (boot-dispose-reason-tdz.test.ts).
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const releaseBotLoops = async (wiring: GatewayBotWiring, id: string): Promise<void> => {
    for (const dispose of wiring.disposers) liveBotLoops.delete(dispose);
    const results = await Promise.allSettled(wiring.disposers.map((dispose) => dispose()));
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn(`[config-reload] bot "${id}" loop dispose failed`, {
          component: 'config-reload',
          bot: id,
          error: reason(r.reason),
        });
      }
    }
  };

  /**
   * The app-level registrations EVERY bot makes, whatever its transport and
   * however it arrived — messaging send, notification routers, personality
   * refreshers, clarify surfaces, approval surface — plus the teardown that
   * undoes exactly them.
   *
   * Shared by the cold-boot loop below, the channel-bot hot-add path
   * (`adaptersSlice` is the one new adapter) and the webhook-route path
   * (`adaptersSlice` is empty, because a `webhooks.<hookId>` bot's transport is
   * the webhook server's per-request capturing adapter). Registered BEFORE any
   * `start()`: Slack's clarify home reader is only picked up by
   * `registerHomeEvents`, which runs inside it.
   */
  const registerBotLive = async (
    bot: (typeof bots)[number],
    wiring: GatewayBotWiring,
    adaptersSlice: PlatformAdapter[],
  ): Promise<() => Promise<void>> => {
    for (const setter of wiring.messagingSetters) setter(gatewayMessagingSend);
    allNotificationRouters.push(...wiring.notificationRouters);
    personalityRefreshers.push(...wiring.refreshers);
    for (const dispose of wiring.disposers) liveBotLoops.add(dispose);
    let correlator: ClarifyCorrelator | undefined;
    let flow: ReturnType<typeof wireApprovalFlow> | undefined;
    // O-T8. A publication's approval card is DM'd by the bot that will publish
    // it, so the map is keyed by botKey and never by platform. Registering the
    // tap handler only fills a handler slot; the owner and revision checks
    // behind it live in `../lib/outbox-wiring`.
    const cardAdapter = adaptersSlice.find(isOutboxCardCapable);
    // Every undo is identity-based (splice THIS router, delete THIS
    // correlator), so it is safe to run against a half-finished registration
    // and safe to run after a replacement has registered under the same
    // botKey.
    const undo = async (): Promise<void> => {
      for (const router of wiring.notificationRouters) {
        const i = allNotificationRouters.indexOf(router);
        if (i >= 0) allNotificationRouters.splice(i, 1);
      }
      for (const refresh of wiring.refreshers) {
        const i = personalityRefreshers.indexOf(refresh);
        if (i >= 0) personalityRefreshers.splice(i, 1);
      }
      if (correlator) clarifyCorrelators.delete(bot.botKey, correlator);
      // Identity-based like every other undo here: a replacement registered
      // under the same botKey keeps its own adapter.
      if (cardAdapter && outboxCardAdapters.get(bot.botKey) === cardAdapter) {
        outboxCardAdapters.delete(bot.botKey);
      }
      if (flow) {
        if (approvalFlows.get(bot.botKey) === flow) approvalFlows.delete(bot.botKey);
        await flow.shutdown();
      }
      // Last: the loop's runtime, once nothing above can route a turn to it.
      await releaseBotLoops(wiring, bot.botKey);
    };
    try {
      correlator = await registerClarifySurfacesFor([bot], adaptersSlice, bot.botKey);
      flow = wireApprovalFlow(gateway, [bot], adaptersSlice, approvalSeams);
      approvalFlows.set(bot.botKey, flow);
      if (cardAdapter) {
        outboxCardAdapters.set(bot.botKey, cardAdapter);
        wireOutboxCardAdapters(outboxSurface, [cardAdapter]);
      }
      wireInitiative(adaptersSlice);
    } catch (err) {
      await undo();
      throw err;
    }
    return undo;
  };

  // Cold-booted bots are wired through the SAME call, into the SAME registry,
  // as anything added later. That is finding 2's fix: `botWiring` used to hold
  // hot-added bots only, so replacing a bot that had been present since boot
  // found no handle to run and left its routers, correlator, approval surface,
  // messaging binding and refresher registered beside the replacement's.
  for (const bot of bots) {
    const wiring = coldBuilt.perBot.get(bot.botKey) ?? {
      messagingSetters: [],
      notificationRouters: [],
      toolRegistries: [],
      refreshers: [],
      disposers: [],
    };
    const own = botAdapterMap.get(bot.botKey);
    botWiring.set(bot.botKey, await registerBotLive(bot, wiring, own ? [own] : []));
  }
  // Last, so `route()`'s delegate-to-element-0 still lands on the first bot's
  // router in a deployment that has one.
  allNotificationRouters.push(shared.notificationRouter);

  // §3c / §11 OQ11 — the SINGLE ownership manager, gateway-role (./boot-callcapture).
  const callCapture = await startBootCallCapture({
    cfg,
    dir,
    storage,
    logger,
    runCallCapture: shared.runCallCapture,
    watcherWake,
    loadModule: () => import('@ethosagent/platform-callcapture'),
  });

  // -------------------------------------------------------------------------
  // §3b step 7 — cron start (its `LocalIntervalTrigger.start()` fires
  // `engine.fire()` immediately: today's implicit catch-up)
  // -------------------------------------------------------------------------
  cronTriggers.local?.start();
  void watcherManager.start().catch((err) => {
    console.error('[watcher] failed to start watcher manager:', err);
  });
  // Reconcile the system cron jobs against config (plan D7). Not just a
  // seeder: a schedule edited in config.yaml is patched onto the existing job,
  // and a feature switched off has its job removed instead of firing forever.
  // Only the jobs in that table are touched — watcher ticks are seeded per
  // watcher by the watcher manager and are left alone.
  void seedAllSystemJobs(scheduler, cfg, 'boot')
    .then((outcomes) => {
      for (const o of outcomes) {
        const problem = systemJobProblem(o);
        if (problem) console.error(`[cron] ${problem}`);
      }
    })
    .catch((err) => {
      console.error('[cron] system job reconciliation failed:', err);
    });

  // -------------------------------------------------------------------------
  // §3b step 8 — adapters started. HARD PRECONDITION for step 9: a delivery
  // sweep against cold adapters sends into nothing while burning obligations.
  // -------------------------------------------------------------------------
  // One failing adapter must not stop the rest (UBP-010), and a failed one is
  // retried in the background until it starts, fails permanently, or
  // `shutdown` aborts `adapterStartRetry` (V-CC-4). One that recovers after the
  // platform-webhook mounts below were built is mounted by
  // `onAdapterRecovered`, assigned there.
  //
  // Unlike `ethos gateway start`, boot does not exit when EVERY adapter failed
  // (V2-RT-5, `allFailed: 'continue'`): this process also hosts the web UI —
  // the Settings page where a revoked token gets fixed — cron and serve. Each
  // failure is already warned about and recorded (`gateway.adapter_start_failed`,
  // then `_abandoned` for a refused credential), and `/healthz`, `/readyz` and
  // `gateway-health.json` report the adapter not ok through its own `health()`.
  const adapterStartRetry = new AbortController();
  let onAdapterRecovered: (adapter: PlatformAdapter) => void = () => {};
  const adapterStart = await startAdaptersIsolated(adapters, {
    observability: gatewayObservability(),
    warn: (message) => console.warn(`${c.yellow}⚠${c.reset} ${message}`),
    allFailed: 'continue',
    retry: {
      signal: adapterStartRetry.signal,
      onStarted: (a) => onAdapterRecovered(a),
      isRetired: (a) => gateway.hasStopped(a),
    },
  });
  if (adapters.length > 0 && adapterStart.started.length === 0) {
    console.warn(
      `${c.yellow}⚠ no chat adapter started — the web UI, cron and serve keep running; fix the bot credentials in Settings or ~/.ethos/config.yaml${c.reset}`,
    );
  }
  heartbeatStartedAt = new Date().toISOString();
  await gateway.pluginsReady();

  // The approval-outbox dispatcher (O-T6). AFTER `adapter.start()` above for
  // exactly the reason step 9's sweeps are: a publication handed to a cold
  // adapter is a human's approval burned on a send that reached nothing.
  //
  // This profile's gateway role is the one that holds adapters, so this is the
  // one place a publication can actually leave — the serve role only writes
  // decisions into the same `outbox.db`.
  const outboxDispatcher = createOutboxDispatcher({
    service: outbox.service,
    gateway,
    ledger: deliveryLedger,
    // Read live: this profile adds and removes bots without a restart, and
    // which rows it may claim changes with them.
    botKeys: () => gateway.listBots().map((bot) => bot.botKey),
    cards: outboxSurface.cards,
    logger,
  });
  void outboxDispatcher.start();

  // -------------------------------------------------------------------------
  // §3b step 9 — THE reconciliation call. This is the step that closes §1's
  // gap: `ethos serve` alone never runs the delivery / job sweeps, and
  // `ethos gateway start` alone never runs A2A `failNonTerminal`. Fail-open
  // per step — `runBootReconciliation` never rejects.
  // -------------------------------------------------------------------------
  // ONE per process, shared with the idle watcher below (see `pause-lifecycle.ts`).
  // A `NoopPauseLifecycle` unless the operator enabled `pauseClockCorrection`,
  // in which case it is a started clock-drift detector.
  const pauseLifecycle = createPauseLifecycle(cfg);
  const reconciliation = await runBootReconciliation({
    cronEngine: scheduler,
    ...(shared.backgroundExecutor ? { backgroundExecutor: shared.backgroundExecutor } : {}),
    // Both roles' bridges: every per-bot gateway bridge plus the shared loop's,
    // which is the one web-api registered its SSE presenter on.
    clarifyBridges: [...bots.map((b) => b.loop.clarifyBridge), systemLoop.clarifyBridge].filter(
      (b): b is NonNullable<typeof b> => b !== undefined,
    ),
    a2aTaskStore: a2a.taskStore,
    gateway,
    // Correction targets for a resume (plan/phases/clock-tolerance-pass.md §4).
    // Only what this profile already holds: the shared job store and the
    // Gateway. `kanbanStore` and `pendingMemoryStore` are not constructed here,
    // and dreaming is not wired in this profile at all (see the file header) —
    // an unsupplied target is skipped by design, and constructing one purely to
    // satisfy the dep would put a second writer on a store nothing else uses.
    //
    // `createAgentLoop` exposes the narrow `JobStore` contract, which has no
    // pause-correction entry point; the `SQLiteJobStore` it actually returns
    // does. Duck-typed rather than `instanceof`-checked because
    // `@ethosagent/job-store` is deliberately NOT a dependency of this app (see
    // `__tests__/boot-profile-reconciliation-gap.test.ts`), and a backend
    // without the method is simply skipped.
    ...(hasHeartbeatBump(shared.jobStore) ? { jobStore: shared.jobStore } : {}),
    // Shared with the idle watcher below: `readPauseOffset()` is consume-on-read,
    // so a second instance would silently eat the offset.
    pauseLifecycle,
    logger,
  });
  if (reconciliation.pauseOffset !== null) {
    console.log(
      `${c.dim}Resumed from a pause of ${reconciliation.pauseOffset.pauseDurationMs}ms${c.reset}`,
    );
  }

  // Inbound spool replay (plan reach-and-containment §2.4). After step 8's
  // `adapter.start()` for the reason the ledger sweep is — a replayed turn
  // replies through a live adapter — and after reconciliation, whose delivery
  // sweep and clarify hydration a replayed message may depend on. The first
  // call arms the Gateway's 60s replay tick; `gateway.shutdown` stops it.
  startInboundSpoolReplay(gateway, {
    info: (message) => console.log(`${c.dim}${message}${c.reset}`),
    warn: (message) => logger.warn(message, { component: 'boot' }),
  });
  // The delivery ledger's periodic sweep (plan openclaw-2026.9.6-gaps R1), after
  // reconciliation's boot sweep; `gateway.shutdown` stops it.
  gateway.startDeliverySweep();
  // Spool retention (D2-11): once now, then hourly — see `pruneInboundSpool`.
  // Session retention (R9) rides the same tick — see `pruneExpiredSessions`.
  const pruneSpool = () => {
    pruneInboundSpool(inboundSpool, {
      observability: gatewayObservability(),
      warn: (message) => logger.warn(message, { component: 'boot' }),
    });
    void pruneExpiredSessions(session, config.retention).catch((err) => {
      logger.warn(`session retention prune failed: ${String(err)}`, { component: 'boot' });
    });
    // Incognito 24 h sweep (plan incognito-sessions D7/D8). Incognito sessions never persist cards
    // (`ChatService.persistCard`, pinned by web-api chat/__tests__/incognito.test.ts).
    void scrubExpiredIncognito(session).catch((err) => {
      logger.warn(`incognito sweep failed: ${String(err)}`, { component: 'boot' });
    });
  };
  pruneSpool();
  const spoolPruneTimer = setInterval(pruneSpool, 3_600_000);
  spoolPruneTimer.unref?.();
  // The mid-run resume seam. `runBootReconciliation` above handles the pause a
  // COLD-BOOTED process learns about from `readPauseOffset()`; this handles the
  // one a RUNNING process lives through, which is what snapshot+restore actually
  // does (the process image continues — no reboot, no boot code re-run). Absent
  // on `NoopPauseLifecycle`, so this is a no-op unless the operator enabled
  // `pauseClockCorrection`.
  //
  // Targets are exactly those `runBootReconciliation` was given, for the same
  // reasons documented at that call: this profile builds no `DreamExecutor` and
  // no kanban store, and a correction pass must not construct one.
  const onPauseResume = pauseLifecycle.onResume?.bind(pauseLifecycle);
  onPauseResume?.((pauseDurationMs) => {
    void applyPauseCorrections(
      {
        gateway,
        ...(hasHeartbeatBump(shared.jobStore) ? { jobStore: shared.jobStore } : {}),
      },
      pauseDurationMs,
      logger,
    );
  });
  const failedSteps = Object.entries(reconciliation.steps)
    .filter(([, outcome]) => outcome === 'failed')
    .map(([name]) => name);
  if (failedSteps.length > 0) {
    console.warn(
      `${c.yellow}⚠ boot reconciliation: ${failedSteps.join(', ')} failed (continuing)${c.reset}`,
    );
  }

  // §8 — one SYNCHRONOUS heartbeat write immediately after reconciliation, so
  // a resume does not sit up to HEARTBEAT_INTERVAL_MS before its first fresh
  // heartbeat lands and a poller reads it as dead.
  let heartbeatInFlight = false;
  const writeHeartbeat = async () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      // LIVE, like the metrics closure above: `adapters` is the boot-time
      // snapshot, still holding a bot a reload retired (reported forever as a
      // stopped adapter) and missing one a reload added.
      const hb = await buildGatewayHeartbeat(gateway.listAdapters(), heartbeatStartedAt);
      await storage.writeAtomic(gatewayHealthPath(), JSON.stringify(hb));
    } catch {
      // Best-effort — the consumer treats stale data as degraded.
    } finally {
      heartbeatInFlight = false;
    }
  };
  await writeHeartbeat();

  // -------------------------------------------------------------------------
  // §3b step 10 — remaining servers bound. Everything external reaches a
  // FULLY reconciled process, ACP included (§11 OQ8, argued above).
  // -------------------------------------------------------------------------
  const metricsApiKeys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
  const eventLoopLag = createEventLoopLagSampler();
  const healthServer = createHealthServer(
    healthPort,
    healthHost,
    async () => {
      const hb = await buildGatewayHeartbeat(gateway.listAdapters(), heartbeatStartedAt);
      return {
        status: gatewayHealthStatus(hb.adapters),
        uptime: process.uptime(),
        pid: hb.pid,
        startedAt: hb.startedAt,
        updatedAt: hb.updatedAt,
        adapters: hb.adapters,
      };
    },
    metricsText,
    createGatewayMetricsAuthCheck(metricsApiKeys),
    {
      // R6 — `/readyz`, live adapters through the 60s `cachedHealth`.
      readiness: createReadinessCheck({
        adapters: async () =>
          (await buildGatewayHeartbeat(gateway.listAdapters(), heartbeatStartedAt)).adapters,
        sqlitePaths: gatewaySqliteStorePaths(dir),
        lagP99Ms: eventLoopLag.p99Ms,
      }),
      eventLoopLagP99Ms: eventLoopLag.p99Ms,
    },
  );
  console.log(`  health:  http://${healthHost}:${healthPort}/healthz`);
  console.log(`  ready:   http://${healthHost}:${healthPort}/readyz`);

  // Inbound webhooks — opt-in, unchanged gate (§11 OQ5: same defaults as today,
  // no new exposure policy for the merged profile).
  const webhookPrefilterBackend = new LocalExecutionBackend({ config: {}, secrets, logger });
  const runWebhookPrefilter: PrefilterRunner = (file, opts) =>
    runScriptFile(
      { file, timeoutSeconds: opts.timeoutSeconds },
      {
        storage,
        executionBackend: webhookPrefilterBackend,
        scriptsDir: ethosScriptsDir(),
        stdin: opts.stdin,
        label: 'prefilter',
      },
    );
  //
  // THE ROUTE TABLE IS LIVE (plan/phases/gateway-live-reload.md Phase C, §0
  // row 5). `createWebhookServer` resolves `webhooks[hookId]` per request, so
  // this object — not a copy of it — is what decides which routes are served.
  // The reconciler below mutates it in place; nothing rebinds the server.
  const liveWebhooks: Record<string, WebhookHookConfig> = { ...(cfg.webhooks ?? {}) };
  let webhookServer: ReturnType<typeof createWebhookServer> | undefined;
  /**
   * Bind the webhook listener if a route now exists and nothing is listening.
   *
   * Called once here and again from the reconciler: a deployment that booted
   * with no `webhooks:` block binds no port at all (the unchanged opt-in gate),
   * so the operator's FIRST live route has to bring the listener up with it.
   * That is a first bind, not Phase D's rebind — the port never changes.
   */
  const ensureWebhookServer = (): void => {
    if (webhookServer || Object.keys(liveWebhooks).length === 0) return;
    webhookServer = createWebhookServer(
      webhookPort,
      webhookHost,
      gateway,
      liveWebhooks,
      createCapturingAdapter,
      runWebhookPrefilter,
      undefined,
      {
        // D12 — a `private: true` hook runs private only when every deliver
        // target is private too (`webhookAudienceHint`).
        targetAudience: (platform, chatId) =>
          targetAudience(platform, chatId, privateChatSetFrom(cfg.gateway?.privateChats)),
      },
    );
    for (const hookId of Object.keys(liveWebhooks)) {
      console.log(`  webhook: http://${webhookHost}:${webhookPort}/webhook/${hookId}`);
    }
  };
  ensureWebhookServer();
  /**
   * The inverse of `ensureWebhookServer`, and the half that was missing.
   *
   * The bind is on demand — no `webhooks:` block, no port — so the unbind has
   * to be on demand too. Without it, removing the last route left the port
   * held by a server whose route table was empty: every request 404'd, this
   * file's own no-route/no-bound-port rule was broken, and an operator who
   * removed a route to free the port for something else found it still taken.
   * Closing clears the handle, so a later live addition binds again through
   * `ensureWebhookServer`.
   */
  const releaseWebhookServerIfIdle = (): void => {
    const bound = webhookServer !== undefined;
    webhookServer = closeIdleRouteListener({
      server: webhookServer,
      routeCount: Object.keys(liveWebhooks).length,
      close: (server) => server.close(),
    });
    if (bound && webhookServer === undefined) {
      logger.info('[config-reload] webhook listener closed — no routes left to serve', {
        component: 'config-reload',
        port: webhookPort,
      });
    }
  };
  // NOT WIRED: the inbound SIP webhook (port 3005). Its handler
  // (`createSipInboundHandler` + the voice stack + call log) is still inline in
  // `runGatewayStart`; Phase 1 did not extract it, and duplicating it here
  // would be the copy-paste the extraction exists to avoid. Telephony
  // deployments should keep using `ethos gateway start`.

  // Native platform webhooks — Telegram + Slack
  // (plan/phases/telegram-slack-webhook-mode.md §2b, §3c, §4).
  //
  // WIRED, unlike the SIP block above, because the asymmetry would be a silent
  // failure rather than a missing feature: `buildGatewayAdapters` is shared with
  // `runGatewayStart`, so a bot with `use_webhook` boots identically here and
  // calls `setWebhook()` against Telegram — registering a public URL with no
  // listener behind it. Every inbound message would then 404 with nothing in
  // this process's logs to say why. There is also nothing to duplicate: the
  // dispatch-map builder and the server are both shared imports.
  //
  // PLACED AFTER `startAdaptersIsolated(adapters, …)` (§3b step 8 above), AND THAT
  // IS LOAD-BEARING — the same ordering constraint `runGatewayStart` documents.
  // `TelegramAdapter.webhook` is `undefined` until `start()` has registered the
  // webhook and built grammy's callback, so building the map any earlier mounts
  // nothing and 404s every delivery.
  //
  // Opt-in and gated on need exactly like the `cfg.webhooks` block above: with
  // no bot in webhook mode and no app in HTTP mode, no port is bound at all.
  //
  // AND THESE TWO MAPS ARE LIVE (Phase C, §0 row 6). `createPlatformWebhookServer`
  // reads them per request, so they are the mount table rather than a snapshot
  // of it: `startAndMountPlatformWebhook` adds a hot-added bot's route and
  // `unmountPlatformWebhook` drops a removed one, with no rebind. Built from
  // `gateway.listAdapters()` for the same reason `liveAdapters` was — one
  // source of truth for "which adapters are live", never a captured array.
  const platformWebhookMounts = buildPlatformWebhookMounts(cfg, gateway.listAdapters(), (message) =>
    logger.warn(message),
  );
  let platformWebhookServer: import('node:http').Server | undefined;
  /** Bind the platform-webhook listener if a route now exists. See
   *  `ensureWebhookServer` — same first-bind-on-demand rule, same reason. */
  const ensurePlatformWebhookServer = (): void => {
    if (platformWebhookServer) return;
    if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;
    // The non-loopback cleartext warning lives inside `createPlatformWebhookServer`
    // — it is the server that knows what host it bound.
    platformWebhookServer = createPlatformWebhookServer({
      port: platformWebhookPort,
      host: platformWebhookHost,
      telegram: platformWebhookMounts.telegram,
      slack: platformWebhookMounts.slack,
    });
    for (const botKey of platformWebhookMounts.telegram.keys()) {
      console.log(
        `  telegram: http://${platformWebhookHost}:${platformWebhookPort}/telegram/webhook/${botKey}`,
      );
    }
    for (const route of platformWebhookMounts.slack.keys()) {
      console.log(`  slack: http://${platformWebhookHost}:${platformWebhookPort}${route}`);
    }
  };
  ensurePlatformWebhookServer();
  // An adapter whose start succeeded on a background retry (V-CC-4) has only
  // now built its webhook handler: mount it in the live table, binding the
  // listener if this is the first route.
  onAdapterRecovered = (adapter) => {
    const mounts = buildPlatformWebhookMounts(cfg, [adapter], (message) => logger.warn(message));
    for (const [botKey, handler] of mounts.telegram)
      platformWebhookMounts.telegram.set(botKey, handler);
    for (const [route, handler] of mounts.slack) platformWebhookMounts.slack.set(route, handler);
    ensurePlatformWebhookServer();
  };
  /** The inverse of `ensurePlatformWebhookServer` — see
   *  `releaseWebhookServerIfIdle` for why an on-demand bind owes an on-demand
   *  unbind. Both mount tables have to be empty: one listener serves the
   *  Telegram routes and the Slack ones. */
  const releasePlatformWebhookServerIfIdle = (): void => {
    const bound = platformWebhookServer !== undefined;
    platformWebhookServer = closeIdleRouteListener({
      server: platformWebhookServer,
      routeCount: platformWebhookMounts.telegram.size + platformWebhookMounts.slack.size,
      close: (server) => server.close(),
    });
    if (bound && platformWebhookServer === undefined) {
      logger.info('[config-reload] platform webhook listener closed — no routes left to serve', {
        component: 'config-reload',
        port: platformWebhookPort,
      });
    }
  };

  const acpHttpServer = acpServer.startHttp(acpPort);
  console.log(`  acp:     http://localhost:${acpPort}`);
  const agentId = `${activePersonalityId}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  const personalityConfig = personalities.get(activePersonalityId);
  await mesh.register({
    agentId,
    capabilities: personalityConfig?.capabilities ?? [],
    model: cfg.model,
    pid: process.pid,
    host: 'localhost',
    port: acpPort,
    activeSessions: 0,
    personalityId: activePersonalityId,
    displayName: personalityConfig?.name ?? activePersonalityId,
    boardSubscriptions: [{ board: 'global' }],
  });
  const stopMeshHeartbeat = mesh.startHeartbeat(agentId, () => acpServer.activeSessionCount);

  // §5 / §11 OQ10 — the web bind is LAST, and it is the one bind that walks a
  // fallback ladder. In one merged process 3001/3002/3003 are this process's
  // own ACP / health / webhook servers, so the ladder is handed the ports it
  // must never take: it skips them and lands past them, or fails loudly naming
  // what it skipped. Never a silent self-collision.
  //
  // Both webhook ports are reserved UNCONDITIONALLY, even when nothing is
  // listening on them yet: Phase C lets a live config edit bind either one
  // later, and a web server that had meanwhile settled on that port would turn
  // the operator's first webhook route into an EADDRINUSE warning.
  const reservedPorts = new Set<number>([acpPort, healthPort, webhookPort, platformWebhookPort]);
  const envToken = resolveWebTokenEnv();
  const tokens = new WebTokenRepository({
    dataDir: dir,
    storage,
    ...(envToken !== undefined ? { envToken } : {}),
  });
  const token = await tokens.getOrCreate();
  //
  // The ladder is also what a Phase D rebind re-runs (§0 row 9), so it is a
  // named closure rather than one inline call: a live `web.port`/`web.host`
  // edit must land through the SAME reservation and fallback rules as cold
  // boot, not a second, subtly different bind path.
  const listenWeb = (bind: WebBindTarget) =>
    listenWithFallback(
      created.app,
      bind.port,
      WEB_PORT_FALLBACK_ATTEMPTS,
      bind.host,
      reservedPorts,
    );
  const attachWebSockets = (target: Awaited<ReturnType<typeof listenWeb>>['server']): void => {
    created.voiceSocket.attach(target);
    created.satelliteSocket.attach(target);
    // Takeover + node lanes: same router, re-attached on a rebind like the two above.
    created.takeoverSocket.attach(target);
    created.nodeSocket?.attach(target);
  };
  /** The address ASKED for. Not the same as the one landed on — the ladder may
   *  have moved the port — and it is the requested one a rebind diffs against. */
  let webRequested: WebBindTarget = { host: webHost, port: webPort };
  const firstBind = await listenWeb(webRequested);
  let webServer = firstBind.server;
  attachWebSockets(webServer);
  /** Print where the web UI now is, plus the one-line non-loopback notice
   *  when the bind is network-reachable and not TLS-fronted. Called at cold
   *  boot and again after a Phase D rebind — a rebind onto `0.0.0.0` is
   *  exactly as exposing as a cold boot onto it, so it owes the operator the
   *  same notice. */
  const announceWebBind = (host: string, boundPort: number): string | null => {
    shareLinks.host.bind = { host, port: boundPort };
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`  web:     http://${displayHost}:${boundPort}`);
    return formatNonLoopbackNotice(host, boundPort, cfg.webBaseUrl);
  };
  const exposureWarning = announceWebBind(webHost, firstBind.port);
  // D2 — with ETHOS_WEB_TOKEN set the operator already holds the token; never
  // print it to logs.
  if (tokens.fromEnv) console.log('  web token: from ETHOS_WEB_TOKEN');
  else if (!webDist) console.log(`  auth token: ${token}`);
  if (exposureWarning) console.warn(exposureWarning);

  // -------------------------------------------------------------------------
  // §3b step 11 — watchdog / heartbeat timers
  // -------------------------------------------------------------------------
  emitReady('boot');
  notifyReady();
  const stopWatchdog = startWatchdog();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Config live-reload (Phases 0, A, C, D) — ./boot-reload.ts. `web` is the
  // live view of `webServer` / `webRequested`: a Phase D rebind writes through
  // it, and shutdown's `closeListener(webServer)` reads what it wrote.
  const web = {
    get server() {
      return webServer;
    },
    set server(next) {
      webServer = next;
    },
    get requested() {
      return webRequested;
    },
    set requested(next) {
      webRequested = next;
    },
  };
  const { configReloadRunner, configReloadTimer } = startConfigReload({
    roomPolicies,
    args,
    cfg,
    dir,
    storage,
    secrets,
    logger,
    scheduler,
    watcherManager,
    outbox,
    attachmentCache,
    gateway,
    gatewayRef,
    botWiring,
    registerBotLive,
    releaseBotLoops,
    liveWebhooks,
    ensureWebhookServer,
    releaseWebhookServerIfIdle,
    platformWebhookMounts,
    ensurePlatformWebhookServer,
    releasePlatformWebhookServerIfIdle,
    web,
    listenWeb,
    attachWebSockets,
    announceWebBind,
    reason,
  });

  console.log(`${c.dim}Listening. Press Ctrl+C to stop.${c.reset}\n`);

  // Idle watcher — declared here only so `shutdown` can stop its interval. It
  // is CONSTRUCTED below the signal handlers, after every subsystem it reads
  // (plan/phases/idle-watcher.md §5).
  let idleWatcher: IdleWatcherManager | undefined;

  // -------------------------------------------------------------------------
  // Shutdown — tears down BOTH roles' resources, mirroring `runGatewayStart`'s
  // `shutdown` and `runServe`'s `cleanup`.
  // -------------------------------------------------------------------------
  //
  // Every step below runs through `guard`. The handlers are invoked as
  // `void shutdown()`, so a single rejection would both skip `process.exit`
  // and surface as an unhandled rejection — leaving the process alive with its
  // adapters half-stopped and still registered in the mesh. `guard` is the
  // sync-throw-safe form of the `.catch(() => {})` this closure already used on
  // `mesh.unregister` / `storage.remove`, applied to every step instead of
  // three of them.
  const guard = (label: string, fn: () => unknown): Promise<void> =>
    Promise.resolve()
      .then(fn)
      .then(
        () => {},
        (err: unknown) => {
          logger.warn(`[boot] shutdown step "${label}" failed`, {
            component: 'boot',
            step: label,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );

  // `step` is `guard` with a deadline (`boundedShutdownStep`,
  // lib/bounded-shutdown-step.ts): for a step whose await has none of its own.
  const stepReporting = {
    sink: gatewayObservability,
    warn: (message: string) => logger.warn(message, { component: 'boot' }),
  };
  const step = (label: string, fn: () => unknown): Promise<void> =>
    boundedShutdownStep(label, fn, stepReporting);

  let shuttingDown: Promise<void> | undefined;
  const shutdown = async (exitCode = 0) => {
    // Reentrancy: this is registered on BOTH SIGINT and SIGTERM, and a second
    // signal — plausibly during the approval drain, which can take up to 5s —
    // would otherwise start a CONCURRENT teardown of the same mesh
    // registration, adapters, SQLite ledger, sockets and HTTP servers. One
    // promise, memoized; every caller awaits that same one.
    shuttingDown ??= (async () => {
      console.log(`\n${c.dim}Shutting down...${c.reset}`);
      adapterStartRetry.abort();
      // FIRST, and it is an await, not a `clearInterval`. A reconcile already
      // in flight adds bots, replaces adapters and rebinds the web server —
      // exactly the resources every step below tears down — so a teardown
      // racing it can walk past a listener or an adapter that the reconcile
      // then brings up behind it, leaving it alive after the process says it
      // is down. `stop()` refuses every further reconcile and waits for the
      // active one to finish before anything is torn down.
      await guard('config-reload', async () => {
        clearInterval(configReloadTimer);
        // Bounded (F06): a reconcile retiring a bot disposes its loop, and a
        // shutdown must not wait on that forever. The per-step bound inside
        // the loop's dispose (`DISPOSE_STEP_TIMEOUT_MS`) normally ends it first.
        await disposeBeforeExit([['config reload', () => configReloadRunner.stop()]], (message) =>
          logger.warn(message, { component: 'boot' }),
        );
      });
      await guard('watchdog', () => {
        if (stopWatchdog) stopWatchdog();
      });
      // Stopped BEFORE the gateway drains: a tick that started now would claim
      // a row this process is about to stop being able to deliver, and leave it
      // `sending` for the ten minutes the stale reconciler waits.
      await step('outbox-dispatcher', async () => {
        outboxDispatcher.stop();
        // Reviews and card round trips start from a fire-and-forget hook, so
        // they are drained BEFORE the adapters stop — otherwise the transport
        // is torn out from under a card mid-update and an approved publication
        // is left showing live buttons.
        await outboxSurface.drain();
      });
      // Deny + audit suspended approvals FIRST on both surfaces — their auto-deny
      // timers are unref'd and never fire on the way out, and a later await that
      // hangs must not cost the audit row or the card update. MUST stay above
      // `adapters.stop()`, which tears out the transport the card updates ride.
      await guard('approval-flow', async () => {
        await Promise.all([...approvalFlows.values()].map((f) => f.shutdown()));
      });
      await guard('force-settle-approvals', () => {
        created.forceSettleApprovals();
      });
      // Chat before the web listener: `closeChat` aborts the web turns and
      // writes the "not sent" notice to each tab's SSE stream, which the
      // listener close below then drops (serve-shutdown-notice.test.ts).
      await guard('close-chat', () => created.closeChat());
      await guard('mesh-heartbeat', () => {
        stopMeshHeartbeat();
      });
      await guard('health-server', () => {
        healthServer.close();
      });
      await guard('webhook-server', () => {
        webhookServer?.close();
      });
      await guard('platform-webhook-server', () => {
        platformWebhookServer?.close();
      });
      await guard('timers', () => {
        clearInterval(pruneTimer);
        clearInterval(heartbeatTimer);
        clearInterval(spoolPruneTimer);
        // `configReloadTimer` is NOT cleared here — the `config-reload` step
        // above cleared it and then awaited the reconcile in flight, before
        // any of the resources that reconcile touches were torn down.
        clearInterval(a2a.retentionTimer);
        idleWatcher?.stop();
        cronTriggers.local?.stop();
        pauseLifecycle.stop?.();
      });
      await step('call-capture-ownership', async () => {
        await callCapture.manager?.stop();
      });
      await step('mesh-unregister', async () => {
        await mesh.unregister(agentId);
      });
      await step('gateway-health-file', async () => {
        await storage.remove(gatewayHealthPath());
      });
      // Bounded by its own `drainTimeoutMs`, notice sends included.
      await guard('gateway', async () => {
        await gateway.shutdown({
          notify:
            '⚠ Ethos was interrupted while answering. Please resend your last message — your session history is preserved.',
        });
      });
      // Plugin-registered and hot-added adapters too — `everyStartedAdapter`.
      await step('adapters', () =>
        Promise.allSettled(everyStartedAdapter(adapters, gateway).map((a) => a.stop())),
      );
      await guard('delivery-ledger', () => {
        deliveryLedger.close();
      });
      await guard('notify-queue', () => {
        heldNotices.close();
      });
      await guard('inbound-dedup', () => {
        inboundDedup.close();
      });
      await guard('inbound-spool', () => {
        inboundSpool.close();
      });
      // Last of the gateway-owned state: from here a new gateway may start.
      await guard('gateway-lock', () => {
        releaseGatewayLock();
      });
      await guard('outbox', () => {
        // After the loops are disposed: a turn still running could propose.
        outbox.close();
      });
      await guard('channel-transcript', () => {
        // A no-op when observe mode never recorded anything.
        channelTranscript.close();
      });
      await guard('slack-session-readers', () => {
        // The App Home / unfurl readers' lazily opened `sessions.db` handles.
        closeSlackSessionStores();
      });
      await step('sockets', () =>
        Promise.allSettled([
          created.voiceSocket.close(),
          created.satelliteSocket.close(),
          created.takeoverSocket.close(),
        ]),
      );
      // The ACP listener. `serve.ts` never closes its own, but this profile
      // moved the ACP bind AFTER reconciliation on a correctness argument and
      // owes the teardown half of it: the idle watcher's `acp-sessions` source
      // reads `acpServer.activeSessionCount`, so leaving the listener up lets
      // the process call itself idle while it is still accepting connections.
      // NOT awaited on the close callback: `/ws` sockets are upgraded out of
      // the server's request cycle, so that callback can wait on a live client
      // forever — and a shutdown that never reaches `process.exit` is worse
      // than a listener the exit tears down a moment later anyway.
      await guard('acp-server', () => {
        acpHttpServer.closeAllConnections();
        acpHttpServer.close();
      });
      await step(
        'web-server',
        // `webServer`, not a captured `server`: a Phase D rebind replaces the
        // listener, and closing the one this process started on would leave
        // the current one up while the exit races it. `closeListener`, not a
        // bare `close()`: an open web UI tab holds `/sse/system`, and a plain
        // close waits on it forever (F06 live smoke).
        () => closeListener(webServer),
      );
      // F06 — the runtimes, last, once every surface above has stopped
      // feeding them: the web API (it borrowed the system loop), every bot
      // loop still wired, then the system loop itself. A job the executors
      // abort here is not delivered through the closed ledger: `gateway.shutdown`
      // above already ran every bot's cleanup, unsubscribing the gateway's
      // completion listener from each executor. Then this process's own
      // sessions.db handles and the observability store — they run even when a
      // dispose above timed out (`disposeBeforeExit` leaves a hung step behind).
      await guard('runtime-dispose', () =>
        disposeBeforeExit(
          [
            ['web api', () => created.dispose()],
            ...[...liveBotLoops].map((dispose) => ['bot loop', dispose] as const),
            ['system loop', shared.dispose],
            ['plugin hosts', closeProcessPluginHostPool],
            [
              'sessions.db',
              async () => {
                contextLog.close();
                session.close();
                apiKeys.close();
                shareLinks.close();
                idempotencyStore.close();
                metricsApiKeys.close();
              },
            ],
            // `a2a/tasks.db` — its retention timer was cleared above; this is
            // the handle itself, the last store this process owns.
            ['a2a tasks.db', async () => a2a.taskStore.close()],
            ['observability.db', async () => closeObservabilityStore()],
          ],
          (message) => logger.warn(message, { component: 'boot' }),
        ),
      );
      process.exit(exitCode);
    })();
    await shuttingDown;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // A stray rejection is logged and survived; an uncaught exception runs this
  // same bounded shutdown and exits 1 (plan openclaw-2026.9.6-gaps R2).
  installProcessGuards({
    command: 'boot',
    observability: getEthosObservability,
    shutdown: (exitCode) => shutdown(exitCode),
  });

  // -------------------------------------------------------------------------
  // Idle watcher (plan/phases/idle-watcher.md §5) — CONSTRUCTED LAST, after
  // every subsystem its sources read, and only when the operator opted in.
  // -------------------------------------------------------------------------
  //
  // `ethos gateway` and `ethos serve` each construct one; this profile is the
  // one that actually needs it, because plan/phases/single-process-boot-
  // profile.md exists to make a scale-to-zero deployment work and the watcher
  // is what decides when suspending is safe. Its sources are the UNION of both
  // roles' builders, reused verbatim — a source written only here would be a
  // source the two split commands silently lack.
  if (cfg.idleWatcher?.enabled === true) {
    idleWatcher = new IdleWatcherManager({
      // Gateway half FIRST, because `dedupeBusySources` keeps the first source
      // per name and the gateway half's twins sample strictly MORE state (see
      // the `bots` note below). Duplicates found today: `team-supervisors`
      // (both builders, identical check against the one `teamsDir()`), plus
      // `background-jobs` and `job-store` whenever the background subsystem is
      // on. Dropping the narrower twin of a fail-awake source would under-
      // report busy, so the order here is load-bearing, not cosmetic.
      sources: dedupeBusySources([
        ...buildGatewayBusySources({
          gateway,
          // Dreaming is not wired in this profile (see the file header), so
          // there is never a dream turn in flight for this to report.
          dreamExecutor: { hasActiveDreams: () => false },
          // The shared system loop's background handles ride along as one more
          // entry, so this builder's `background-jobs` / `job-store` sources
          // aggregate BOTH roles' work. That is what makes dropping the serve
          // half's same-named sources below lossless: without this fold the
          // survivor would see the per-bot executors only and miss every job
          // the web/cron/ACP surfaces started.
          //
          // NO STATIC `...bots` SNAPSHOT. `buildGatewayBusySources` folds
          // `deps.bots` into its counters once, at construction, and the idle
          // watcher's `sources` are readonly — so a captured array reports
          // retired bots' stores and misses the ones that replaced them. It used
          // to be a static half plus a "hot bots only" half split by botKey, and
          // a REPLACED bot keeps its botKey: it landed in neither, and the
          // process could suspend with its work in flight. One live fold covers
          // every bot however it got there.
          bots: [
            createLiveBotBusySource(() => gateway.listBots()),
            { jobStore: shared.jobStore, backgroundExecutor: shared.backgroundExecutor },
          ],
          // Cold-boot surface plus every hot-added bot's own, read live.
          approvalFlow: {
            pendingCount: () =>
              [...approvalFlows.values()].reduce((n, f) => n + f.pendingCount(), 0),
          },
          // A façade, not the handle: Phase C can bind the webhook listener
          // after this point (an operator's first live route), and a captured
          // `undefined` would leave those held connections invisible to the
          // idle watcher — which would then suspend the process out from under
          // a caller waiting on a reply.
          webhookServer: {
            inFlightSyncRequests: () => webhookServer?.inFlightSyncRequests() ?? 0,
          },
          cronScheduler: scheduler,
          // Flat layout: `pidFilePath(name)` in @ethosagent/team-supervisor
          // resolves to `<teamsDir()>/<name>.pid`, so this is the dir the PID
          // files it writes actually land in.
          teamsPidDir: teamsDir(),
          callCaptureActive: callCapture.manager ? callCapture.isActive : undefined,
          outboxPending: outbox.pendingPublications,
        }),
        ...buildServeBusySources({
          chatService: created.chatService,
          voiceSocket: created.voiceSocket,
          satelliteSocket: created.satelliteSocket,
          pendingApprovalCount: created.pendingApprovalCount,
          backgroundExecutor: shared.backgroundExecutor,
          jobStore: shared.jobStore,
          cronScheduler: scheduler,
          teamsPidDir: teamsDir(),
          acpServer,
          callCaptureActive: callCapture.manager ? callCapture.isActive : undefined,
        }),
      ]),
      // The same instance boot reconciliation read the pause offset from. Its
      // outbound half is still a no-op: a real host adapter that signals a
      // Firecracker-style control plane is a later phase, so the watcher's
      // arming gates are what matter here.
      pauseLifecycle,
      // Flips to `true` when the `pauseLifecycle` above becomes a real host
      // adapter. While it is a no-op, `signalReadyToSuspend()` resolves,
      // latches, and stops the watcher having suspended nothing — so gate 3b
      // refuses to arm rather than accept that as a handoff.
      hostSignalAvailable: pauseLifecycle.hostSignalAvailable ?? false,
      capabilities: deriveIdleWatcherCapabilities(cfg),
      options: cfg.idleWatcher,
      logger,
    });
    // Fire-and-forget: `start()` evaluates the arming gates itself and is a
    // no-op (with a logged reason) when any of them refuses.
    idleWatcher.start();
    // Re-arm after a resume. `IdleWatcherManager` latches `signalled` and
    // stops itself once it has handed off, and `start()` is the ONE path that
    // clears that latch and resets the streak and cooldown — so without a
    // caller a snapshot-restored process would suspend exactly once and never
    // again.
    //
    // On a cold boot `pauseOffset` is null and this branch never runs — `start()`
    // above has already armed the watcher exactly once. It covers the case where
    // this process genuinely cold-booted after a restore and learned the pause
    // from `readPauseOffset()`.
    if (reconciliation.pauseOffset !== null) {
      idleWatcher.start();
      logger.info(
        `[idle-watcher] re-armed after a pause of ${reconciliation.pauseOffset.pauseDurationMs}ms`,
        { component: 'idle-watcher' },
      );
    }
    // THE MID-RUN PATH, and the one that actually fires under snapshot+restore.
    // That deployment continues the same process image, so nothing above runs a
    // second time; the clock-drift detector is the only thing that observes the
    // resume. Registering here re-arms the watcher AND applies every clock
    // correction this profile can — previously the corrections had no live
    // trigger at all and the watcher would have suspended exactly once, ever.
    // Captured: `idleWatcher` is a `let` assigned inside this branch, so the
    // closure cannot narrow it away from `undefined` at the point it runs.
    const watcher = idleWatcher;
    onPauseResume?.((pauseDurationMs) => {
      watcher.start();
      logger.info(`[idle-watcher] re-armed after a pause of ${pauseDurationMs}ms`, {
        component: 'idle-watcher',
      });
    });
  }

  await new Promise(() => {});
}
