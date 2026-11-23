import { spawn } from 'node:child_process';
// Storage-abstraction exception, same one `pairing-commands.ts` takes: the
// presence check for a `@ethosagent/sqlite` database file, which opens raw
// paths and manages WAL/SHM natively. See `openChannelTranscriptStore`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { StorageA2aAllowlist } from '@ethosagent/a2a';
import { type CallLog, SQLiteCallLog } from '@ethosagent/call-log';
import { SQLiteChannelTranscriptStore } from '@ethosagent/channel-transcript-sqlite';
import {
  applyPlatformShim,
  deriveBotKey,
  type EthosConfig,
  ethosCronDir,
  ethosDir,
  ethosScriptsDir,
  loadConfigStrict,
  observeModePlatforms,
  readRawConfig,
  type SlackAppConfig,
  type TelegramBotConfig,
  validateBotBindings,
  writeConfig,
} from '@ethosagent/config';
import {
  type AgentLoop,
  deriveBotKey as deriveBotKeyFromSeed,
  LaneVoiceModeStore,
  laneVoiceModePath,
  privateChatSetFrom,
  SHARED_AUDIENCE_EXCLUDED_TOOLS,
  targetAudience,
} from '@ethosagent/core';
import {
  buildCronTriggers,
  type CronJob,
  CronScheduler,
  type CronTriggers,
  runScriptFile,
} from '@ethosagent/cron';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { LangfusePollLoop } from '@ethosagent/export-langfuse';
import {
  adapterRegistries,
  type BotSpend,
  createCapturingAdapter,
  createFfmpegTranscoder,
  createVoiceArtifactStore,
  DreamExecutor,
  Gateway,
  type GatewayBotConfig,
  relayToTargets,
  summarizeChannelDigest,
} from '@ethosagent/gateway';
import { registerGoalNotifications } from '@ethosagent/goal-runner';
import { type BusySource, IdleWatcherManager } from '@ethosagent/idle-watcher';
import { SQLiteInboundDedupStore } from '@ethosagent/inbound-dedup';
import { KanbanStore } from '@ethosagent/kanban-store';
import { ConsoleLogger } from '@ethosagent/logger';
import { createMetricsTextProvider } from '@ethosagent/observability-sqlite';
import {
  createPersonalityRegistry,
  firstParagraph,
  PersonalityA2aIdentityProvider,
} from '@ethosagent/personalities';
import {
  CallCaptureDaemon,
  CallCaptureOwnershipManager,
  CaptureIndicator,
  callCaptureHealthPath,
  callCaptureLockPath,
  checkCallCaptureDependencies,
  MicActivityDetector,
  NotificationGate,
} from '@ethosagent/platform-callcapture';
import {
  hashApiKey,
  SQLiteSessionStore,
  SQLiteUsageLedger,
  SqliteApiKeyStore,
} from '@ethosagent/session-sqlite';
import { bundledSkillsSource, createInjectors } from '@ethosagent/skills';
import Database from '@ethosagent/sqlite';
import {
  hasLiveTeamProcesses,
  readRuntime,
  removeRuntime,
  teamsDir,
} from '@ethosagent/team-supervisor';
import { createA2aTools } from '@ethosagent/tools-a2a';
// Platform adapters are loaded LAZILY in runGatewayStart() — see plan/IMPROVEMENT.md P0-3.
// Their underlying SDKs (grammy, discord.js, @slack/bolt, imapflow…) are
// optionalDependencies of @ethosagent/cli. A failed install for any one of
// them must not crash the CLI for users who don't run that platform.
import {
  type ChannelTranscriptStore,
  type ClarifyResponse,
  EthosError,
  type GatewayMessagePayload,
  type GatewayMessageResult,
  type InboundMessage,
  type NotificationRouter,
  type PlatformAdapter,
  resolveModelDisplay,
  type SessionStore,
  type ToolRegistry,
  type TurnAudience,
} from '@ethosagent/types';
import {
  type WatcherDeliverTarget,
  WatcherManager,
  type WatcherWakeEvent,
} from '@ethosagent/watchers';
import {
  createLazyProvider,
  createOutboundPolicyGate,
  createSessionStore,
  IdentityMap,
  initPairingDb,
  type MessagingSendFn,
  OtlpPollLoop,
  type OutboxWiring,
  resolveKanbanDbPath,
  resolveOtlpSettings,
  SQLiteNotifyQueue,
  seedAllSystemJobs,
  systemJobProblem,
} from '@ethosagent/wiring';
import {
  createEventLoopLagSampler,
  createHealthServer,
  createReadinessCheck,
  type MetricsAuthCheck,
} from '../health-server';
import { boundedShutdownStep } from '../lib/bounded-shutdown-step';
import { exitIfConfigInvalid } from '../lib/config-exit';
import { createCronDeliver } from '../lib/cron-deliver';
import { disposeBeforeExit } from '../lib/dispose-before-exit';
import {
  openInboundSpool,
  pruneInboundSpool,
  startInboundSpoolReplay,
  takeGatewayLockOrExit,
} from '../lib/gateway-inbound-durability';
import { scrubExpiredIncognito } from '../lib/incognito-retention';
import {
  createOutboxApprovalSurface,
  createOutboxDispatcher,
  createOutboxReviewer,
  createOutboxRuntime,
  isOutboxCardCapable,
  loadOutboxCardRefs,
  OUTBOX_CARDS_FILE,
  type OutboxApprovalSurface,
  type OutboxCardCapableAdapter,
  wireOutboxCardAdapters,
} from '../lib/outbox-wiring';
import { formatQuickCommandOutput, runQuickCommand } from '../lib/quick-command-runner';
import { pruneExpiredSessions } from '../lib/session-retention';
import { callCaptureWake, watcherWakeMessage } from '../lib/watcher-wake';
import { emitReady } from '../logger';
import { migrateSessionKeysIfNeeded } from '../migrations/session-keys-multi-bot';
import { applyPauseCorrections, hasHeartbeatBump } from '../pause-corrections';
import { createPauseLifecycle } from '../pause-lifecycle';
import { createPlatformWebhookServer } from '../platform-webhook-server';
import { closeProcessPluginHostPool, openProcessPluginHostPool } from '../plugin-host-pool';
import { installProcessGuards } from '../process-guards';
import { notifyReady, startWatchdog } from '../sd-notify';
import { createSipInboundHandler } from '../sip-inbound-dispatch';
import { createSipWebhookServer } from '../sip-webhook-server';
import {
  reportUnattendedCronExposure,
  wireUnattendedApprovalGate,
} from '../unattended-approval-gate';
import { buildVersionInfo } from '../version-info';
import { createWebhookServer, type DeliveryRelay, type PrefilterRunner } from '../webhook-server';
import {
  buildSystemTaskHandlers,
  closeObservabilityStore,
  createAgentLoop,
  createLLM,
  createTeamAgentLoop,
  deriveIdleWatcherCapabilities,
  getEthosObservability,
  getFunnelTracker,
  getObservabilityStore,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import {
  CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
  c,
  gatewayHealthPath,
  HEARTBEAT_INTERVAL_MS,
} from './_shared';
import { createCronRunJob, cronContextAudience, cronFiringAudience } from './cron-turn';
import {
  adapterStartFailureExitCode,
  buildPlatformWebhookMounts,
  everyStartedAdapter,
  gatewayAllFailedPolicy,
  startAdaptersIsolated,
  warnEmailSenderAuthUnconfigured,
} from './gateway-adapters';
import { wireApprovalFlow } from './gateway-approval';
import {
  attachMcpLogin,
  type BuildGatewayBotsResult,
  type GatewayBotWiring,
  whatsAppBotKey,
} from './gateway-bots';
import {
  type GatewayHeartbeat,
  gatewayHealthStatus,
  gatewaySqliteStorePaths,
} from './gateway-health';
import {
  type AdapterModuleLoader,
  createSlackMemoryReader,
  createSlackSessionReaders,
  slackSessionStores,
  slackSlashAllowlist,
} from './gateway-platform-readers';
import {
  buildBotSpeakers,
  buildChannelSpeakers,
  deriveChannelVoiceOut,
  resolveTelephonyMedia,
} from './gateway-voice';
import {
  type BuildGatewayOptions,
  type GatewayTurnOrigin,
  gatewayObservability,
  gatewayTurnOrigin,
  idleGatewayBot,
  idleGatewayBotLoopOpts,
  resolveGatewayQuietHours,
  wireAdapterInbound,
} from './gateway-wiring';
import {
  ensureTeamSupervisors,
  stopTeamSupervisors,
  type TeamSupervisorDeps,
} from './supervisor-lifecycle';
import { isPidAlive } from './team-runtime';

export type { AdapterStartRetryOptions, PlatformWebhookMounts } from './gateway-adapters';
export {
  ADAPTER_START_RETRY_BASE_MS,
  ADAPTER_START_RETRY_MAX_MS,
  AllAdaptersFailedError,
  adapterStartFailureExitCode,
  adapterStartRetryDelayMs,
  buildPlatformWebhookMounts,
  everyStartedAdapter,
  gatewayAllFailedPolicy,
  isPermanentAdapterStartError,
  startAdaptersIsolated,
  warnEmailSenderAuthUnconfigured,
} from './gateway-adapters';
export { wireApprovalFlow } from './gateway-approval';
export type { BuildGatewayBotsResult, GatewayBotWiring } from './gateway-bots';
export { whatsAppBotKey } from './gateway-bots';
export type { GatewayHeartbeat } from './gateway-health';
export { gatewayHealthStatus, gatewaySqliteStorePaths } from './gateway-health';
export type { AdapterModuleLoader } from './gateway-platform-readers';
export { createSlackMemoryReader } from './gateway-platform-readers';
export type { BotSpeakers, TelephonyMediaOutcome } from './gateway-voice';
export {
  buildBotSpeakers,
  buildChannelSpeakers,
  deriveChannelVoiceOut,
  resolveTelephonyMedia,
} from './gateway-voice';
export type { BuildGatewayOptions, GatewayTurnOrigin } from './gateway-wiring';
export {
  gatewayObservability,
  gatewayTurnOrigin,
  IDLE_GATEWAY_BOT_KEY,
  idleGatewayBot,
  idleGatewayBotLoopOpts,
  resolveGatewayQuietHours,
  wireAdapterInbound,
} from './gateway-wiring';

// ---------------------------------------------------------------------------
// Gateway heartbeat
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 5_000;
/** How long a CONFIRMED delivery obligation is kept before it is pruned. The
 *  rows hold message bodies, so an unbounded ledger is a privacy and disk
 *  problem. Hard-coded on purpose — no config knob until someone needs one. */
const DELIVERY_LEDGER_RETENTION_MS = 7 * 86_400_000;
/** How long an ENDED call row is kept. Longer than the delivery ledger's week
 *  because a call row is history an operator reads (who rang, what was said),
 *  not an in-flight obligation — but still bounded: the rows hold transcripts. */
const CALL_LOG_RETENTION_MS = 30 * 86_400_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('health check timeout')), ms).unref(),
    ),
  ]);
}

/** How long one adapter `health()` result is reused (R9). The heartbeat writer
 *  ticks every HEARTBEAT_INTERVAL_MS and `/healthz`, `/readyz` and `/metrics`
 *  each build a heartbeat per request; without this, an adapter whose probe is
 *  a network round trip — the email adapter's is a full IMAP connect + logout
 *  (`EmailAdapter.health`) — logged in every 10 seconds and on every scrape. */
const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new WeakMap<PlatformAdapter, { at: number; ok: Promise<boolean> }>();

/**
 * One adapter's health, probed at most once per HEALTH_CACHE_TTL_MS. The
 * in-flight probe is cached too, so concurrent callers share it; a rejection
 * or a HEALTH_TIMEOUT_MS timeout is cached as `false` for the same window.
 * Keyed by adapter object, so a bot a live reload adds starts uncached.
 * Pinned by the 'health cache' cases in
 * `apps/ethos/src/commands/__tests__/gateway-health.test.ts`.
 */
function cachedHealth(adapter: PlatformAdapter): Promise<boolean> {
  const now = Date.now();
  const hit = healthCache.get(adapter);
  if (hit && now - hit.at < HEALTH_CACHE_TTL_MS) return hit.ok;
  const ok = withTimeout(adapter.health(), HEALTH_TIMEOUT_MS).then(
    (r) => r.ok,
    () => false,
  );
  healthCache.set(adapter, { at: now, ok });
  return ok;
}

export async function buildGatewayHeartbeat(
  adapters: PlatformAdapter[],
  startedAt: string,
): Promise<GatewayHeartbeat> {
  const results = await Promise.all(adapters.map((a) => cachedHealth(a)));
  const adapterStatuses = adapters.map((a, i) => ({ name: a.id, ok: results[i] ?? false }));
  return {
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    adapters: adapterStatuses,
    rssBytes: process.memoryUsage.rss(),
  };
}

/**
 * P2-counters (D16/D17) — gates the gateway health server's `/metrics`
 * behind `metrics:read`, mirroring
 * `apps/web-api/src/middleware/bearer-auth.ts`'s core check (parse
 * `Authorization: Bearer sk-ethos-...`, `hashApiKey()` the secret,
 * `findByHash()`, require the scope). Exported so the auth logic itself is
 * testable without booting the full gateway.
 */
export function createGatewayMetricsAuthCheck(apiKeys: SqliteApiKeyStore): MetricsAuthCheck {
  return async (authorizationHeader) => {
    if (!authorizationHeader?.startsWith('Bearer ')) return false;
    const secret = authorizationHeader.slice('Bearer '.length).trim();
    if (!secret.startsWith('sk-ethos-')) return false;
    const record = await apiKeys.findByHash(hashApiKey(secret));
    // biome-ignore lint/complexity/useOptionalChain: optional-chaining here returns boolean | undefined, not the boolean MetricsAuthCheck requires.
    return record !== null && record.scopes.includes('metrics:read');
  };
}

// Best-effort dynamic import. Returns null and logs a clear warning if the
// module can't be loaded — typically because its underlying SDK isn't
// installed. Callers downgrade gracefully.
// Each branch uses a LITERAL-STRING dynamic import so tsup follows it
// statically and inlines the workspace package (`@ethosagent/platform-*`)
// into the published cli bundle. Earlier this function did
// `await import(modulePath)` where `modulePath` was a parameter — tsup
// can't statically resolve that, so the published dist tried to resolve
// the workspace packages from npm at runtime and 404'd ("Cannot find
// package '@ethosagent/platform-telegram' imported from
// node_modules/@ethosagent/cli/dist/index.js"). Keep additions here in
// lockstep with new platform modules.
//
// The adapter SDKs (grammy, @slack/bolt, discord.js, imapflow/mailparser/
// nodemailer) are optionalDependencies, absent under `npm install
// --omit=optional`. No platform module imports its SDK at top level — each
// loads it in its own `sdk.ts` — so the SDK is loaded HERE, right after the
// module, and a missing one lands in the catch below as "<Label> adapter
// unavailable (<Label> adapter needs <pkg>; install it with …)" instead of
// crashing the CLI at startup.
async function loadAdapterModule<T>(modulePath: string, label: string): Promise<T | null> {
  try {
    let mod: unknown;
    switch (modulePath) {
      case '@ethosagent/platform-telegram': {
        const telegram = await import('@ethosagent/platform-telegram');
        await telegram.loadTelegramSdk();
        mod = telegram;
        break;
      }
      case '@ethosagent/platform-slack': {
        const slack = await import('@ethosagent/platform-slack');
        await slack.loadSlackSdk();
        mod = slack;
        break;
      }
      case '@ethosagent/platform-discord': {
        const discordMod = await import('@ethosagent/platform-discord');
        await discordMod.loadDiscordSdk();
        mod = discordMod;
        break;
      }
      case '@ethosagent/platform-email': {
        const email = await import('@ethosagent/platform-email');
        await email.loadEmailSdk();
        mod = email;
        break;
      }
      case '@ethosagent/platform-telegram/clarify-surface':
        mod = await import('@ethosagent/platform-telegram/clarify-surface');
        break;
      case '@ethosagent/platform-slack/clarify-surface':
        mod = await import('@ethosagent/platform-slack/clarify-surface');
        break;
      case '@ethosagent/platform-discord/clarify-surface':
        mod = await import('@ethosagent/platform-discord/clarify-surface');
        break;
      case '@ethosagent/platform-whatsapp':
        mod = await import('@ethosagent/platform-whatsapp');
        break;
      case '@ethosagent/platform-whatsapp/clarify-surface':
        mod = await import('@ethosagent/platform-whatsapp/clarify-surface');
        break;
      default:
        throw new EthosError({
          code: 'INTERNAL',
          cause: `loadAdapterModule: unknown module '${modulePath}'`,
          action:
            'Add a literal-string switch arm in apps/ethos/src/commands/gateway.ts so the bundler can inline this module.',
        });
    }
    return mod as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${c.yellow}⚠ ${label} adapter unavailable${c.reset} ${c.dim}(${reason})${c.reset}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// ethos gateway setup
// ---------------------------------------------------------------------------

export async function runGatewaySetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  console.log(`\n${c.cyan}${c.bold}ethos gateway setup${c.reset}\n`);
  console.log(
    `${c.dim}Create a Telegram bot at https://t.me/BotFather, then paste the token below.${c.reset}\n`,
  );

  const token = (await ask('Telegram bot token: ')).trim();
  rl.close();

  if (!token) {
    console.log(
      `${c.yellow}No token entered. Run ethos gateway setup again to configure.${c.reset}`,
    );
    return;
  }

  // Validate token by calling getMe
  console.log(`${c.dim}Validating token...${c.reset}`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };

    if (!data.ok) {
      console.log(`${c.red}Invalid token — Telegram rejected it.${c.reset}`);
      return;
    }

    const username = data.result?.username ?? '(unknown)';
    console.log(`${c.green}✓ Bot validated: @${username}${c.reset}`);
  } catch {
    console.log(
      `${c.yellow}Warning: could not reach Telegram to validate token. Saving anyway.${c.reset}`,
    );
  }

  const storage = getStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    console.log(`${c.red}No ethos config found. Run ethos setup first.${c.reset}`);
    return;
  }

  await writeConfig(storage, { ...config, telegramToken: token }, await getSecretsResolver());
  console.log(`${c.green}✓ Token saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos gateway start${c.reset}${c.dim} to start the bot.${c.reset}\n`,
  );
}

// ---------------------------------------------------------------------------
// ethos gateway start
// ---------------------------------------------------------------------------

export interface GatewayStartOptions {
  /** Fired once the gateway is fully up and listening — used by the setup
   *  three-way close (W2.5) to print the `t.me` deep-link success block after
   *  the "Starting the Telegram bot…" line. */
  onReady?: () => void;
}

export async function runGatewayStart(opts: GatewayStartOptions = {}): Promise<void> {
  // Load config through the strict path so parse-time errors (typos in
  // bind.type, missing bot tokens) surface here instead of silently
  // booting zero bots. The strict loader also applies the legacy →
  // list-shape shim and returns the deprecation messages we should
  // surface before any other work.
  const storage = getStorage();
  const secrets = await getSecretsResolver();
  const loaded = await loadConfigStrict(storage, secrets);
  if (!loaded) {
    console.error('Run ethos setup first.');
    process.exit(1);
  }
  exitIfConfigInvalid('Config parse errors', loaded.parseErrors);
  for (const note of loaded.deprecations) {
    console.log(`${c.yellow}⚠ deprecation${c.reset} ${c.dim}${note}${c.reset}`);
  }
  const config = loaded.config;
  // `logs.level` — the lowest severity every ConsoleLogger built here prints.
  const logLevel = config.logs?.level;
  // The process's one plugin host pool (plan plugin-process-isolation D4):
  // `createAgentLoop` lends it to every loop built below, bots included.
  // Disposed in `shutdown`, after the loops that borrow it.
  await openProcessPluginHostPool(config, storage);

  // One gateway per state dir (plan reach-and-containment §2.7). Taken right
  // after config load and BEFORE any store is opened or adapter constructed;
  // refused → exit 3. Shared with `ethos boot` — see `takeGatewayLockOrExit`.
  const releaseGatewayLock = await takeGatewayLockOrExit(ethosDir());

  const identityMap = new IdentityMap({ storage, dataDir: ethosDir() });
  const resolveUserId = (platform: string, platformUserId: string, displayLabel?: string) =>
    identityMap.resolve(platform, platformUserId, displayLabel);

  const hasEmailConfig =
    config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost;

  const hasAnyPlatform =
    config.telegramToken ||
    config.discordToken ||
    (config.slackBotToken && config.slackAppToken && config.slackSigningSecret) ||
    (config.telegram?.bots.length ?? 0) > 0 ||
    (config.slack?.apps.length ?? 0) > 0 ||
    (config.whatsapp?.length ?? 0) > 0 ||
    hasEmailConfig;

  if (!hasAnyPlatform) {
    console.log(
      `${c.dim}No platform configured — gateway idling. Run: ethos gateway setup to add one.${c.reset}`,
    );
  }

  // Validate bot bindings against the on-disk personality registry and
  // team manifests. Fail loudly here rather than letting messages route
  // to a non-existent destination at first request.
  const bindErrors = await validateBindings(config);
  exitIfConfigInvalid('Bot binding errors', bindErrors);

  // Migrate persisted session keys to the new `${platform}:${botKey}:
  // ${chatId}` shape if we haven't already. Idempotent — subsequent
  // boots see the marker and short-circuit.
  const migration = await migrateSessionKeysIfNeeded({ storage, config });
  if (migration && migration.migrated > 0) {
    console.log(
      `${c.dim}Migrated ${migration.migrated} session key(s) to the multi-bot lane format.${c.reset}`,
    );
  }

  console.log(`${c.bold}ethos gateway${c.reset}  ${c.dim}starting...${c.reset}`);
  // First-run notice: gateway is opt-in for always-on channels. CLI is the
  // supported install. See plan/phases/30-robustness.md § 30.5.
  console.log(
    `${c.dim}Runs in the foreground. For always-on production, see https://ethosagent.ai/docs/guides/run-as-daemon (launchd / systemd / pm2). For interactive use, run ${c.reset}${c.bold}ethos chat${c.reset}${c.dim}.${c.reset}`,
  );

  // Cron scheduler — hoisted ABOVE every loop construction so the same
  // instance can be threaded into every createAgentLoop call (which
  // registers the agent-callable `cron` tool against it) AND used as the
  // firing engine below. The `runJob` closure captures `systemLoop` via
  // a forward-referenced `let`; the scheduler doesn't fire until
  // `.start()` later, by which point `systemLoop` is assigned. This
  // lets any personality with `cron` in its toolset register jobs that
  // land in the same store as operator-created jobs.
  let systemLoop: import('@ethosagent/core').AgentLoop | null = null;
  let cronPersonalities: Awaited<ReturnType<typeof createPersonalityRegistry>> | null = null;
  // Forward-reference: filled after the Gateway + adapters are built.
  let cronDeliverFn:
    | ((job: import('@ethosagent/cron').CronJob, output: string) => Promise<void>)
    | null = null;
  // Watcher manager — constructed BEFORE the scheduler so its systemTask
  // handler can be merged into the scheduler's `systemTasks` config (watcher
  // ticks piggyback on the cron scheduler as source:'system' jobs — no
  // second ticker). Deliver/wake are forward-referenced like `cronDeliverFn`:
  // bound after the Gateway + bots exist, fired only once the scheduler runs.
  let watcherDeliverFn: ((target: WatcherDeliverTarget, text: string) => Promise<void>) | null =
    null;
  // Resolves whether a turn was started — `false` costs the watcher no fire
  // (`WatcherManagerConfig.wake`).
  let watcherWakeFn: ((event: WatcherWakeEvent) => Promise<boolean>) | null = null;
  // Named (rather than inlined into `WatcherManager`'s `wake` field below) so
  // the SAME wake path can also drive the call-capture daemon's audit-trail
  // leg further down — mirrors serve.ts's `watcherWake` closure, reused for
  // both `WatcherManager` and `CallCaptureDaemon` rather than duplicated.
  const watcherWake = async (event: WatcherWakeEvent): Promise<boolean> =>
    watcherWakeFn ? watcherWakeFn(event) : false;
  // The registry this process answers personality-policy questions from —
  // `personalityDirectory.refresh()` below reloads it. Built here, ahead of
  // the watcher manager, because the manager's delivery gate reads it.
  const personalitiesDir = join(ethosDir(), 'personalities');
  const seamPersonalities = await createPersonalityRegistry(getStorage());
  await seamPersonalities.loadFromDirectory(personalitiesDir);
  try {
    seamPersonalities.setDefault(config.personality);
  } catch {
    // Configured default not on disk — keep the registry's built-in default.
  }
  const watcherManager = new WatcherManager({
    storage: getStorage(),
    logger: new ConsoleLogger({}, logLevel),
    // Judges a watcher's origin chat and delivery target for its wake
    // audience (`WatcherManager.wakeAudience`), honouring trusted rooms.
    targetAudience: (platform, chatId) =>
      targetAudience(platform, chatId, privateChatSetFrom(config.gateway?.privateChats)),
    deliver: async (target, text) => {
      if (watcherDeliverFn) await watcherDeliverFn(target, text);
    },
    wake: watcherWake,
    // The approval outbox's delivery-time hold (O-T12): one gate per manager,
    // in place before the first tick rather than late-bound by whichever loop
    // is composed last. The policy is looked up on every delivery, after
    // `reload` brings the registry up to date — a tick is not a turn, so the
    // per-turn refresh has not run.
    deliveryGate: createOutboundPolicyGate({
      lookupPersonality: (id) => seamPersonalities.get(id),
      ownerTarget: (platform) => config.channelFilter?.[platform]?.ownerUserId,
      reload: () => seamPersonalities.loadFromDirectory(personalitiesDir),
    }),
  });
  const scheduler = new CronScheduler({
    storage: getStorage(),
    cronDir: ethosCronDir(),
    scriptsDir: ethosScriptsDir(),
    // A shared firing reads only shared `contextFrom` output (E1).
    runAudience: cronContextAudience(privateChatSetFrom(config.gateway?.privateChats)),
    logger: new ConsoleLogger({}, logLevel),
    ...(config.cron?.defaultMaxRunMs !== undefined
      ? { defaultMaxRunMs: config.cron.defaultMaxRunMs }
      : {}),
    ...(config.cron?.maxParallelJobs !== undefined
      ? { maxParallelJobs: config.cron.maxParallelJobs }
      : {}),
    // Script/precheck jobs execute through the same local backend class the
    // execution tools use — never raw child_process in the scheduler.
    executionBackend: new LocalExecutionBackend({
      config: {},
      secrets,
      logger: new ConsoleLogger({}, logLevel),
    }),
    systemTasks: {
      ...buildSystemTaskHandlers(config),
      ...watcherManager.systemTasks(),
      // Contributed here rather than by `buildSystemTaskHandlers`: the digest
      // needs the live Gateway (`sendVia`, the per-bot loops, the transcript
      // store), which the shared handler table has no access to. Forward-
      // referenced like `cronDeliverFn` above — the Gateway is built before
      // `cronTriggers.local.start()`, so it is always set by the time this
      // fires.
      'channel-digest': channelDigestSystemTask(config, () => gatewayRef),
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
    deliver: async (job, output) => {
      if (cronDeliverFn) await cronDeliverFn(job, output);
    },
    // The one cron turn implementation (`runCronTurn`, via `createCronRunJob`):
    // an `error` event fails the run instead of recording it as a success, and
    // only the final answer is delivered (UBP-004, UBP-025).
    runJob: createCronRunJob({
      loop: () => {
        if (!systemLoop) {
          throw new EthosError({
            code: 'INTERNAL',
            cause: 'System loop not yet initialised at cron firing time',
            action:
              'This is a wiring bug — the scheduler started before the agent loop was assigned. File an issue.',
          });
        }
        return systemLoop;
      },
      // Recursion guard: exclude 'cron' from the effective toolset so
      // cron-spawned sessions cannot schedule further cron jobs.
      // Refresh-before-use (not create-once-cache-forever) so a personality
      // created/edited after boot is honored the next time cron fires.
      toolsetFor: async (job: CronJob) => {
        if (!cronPersonalities) {
          cronPersonalities = await createPersonalityRegistry(getStorage());
        }
        await cronPersonalities.loadFromDirectory(join(ethosDir(), 'personalities'));
        return cronPersonalities
          .get(job.personalityId)
          ?.toolset?.filter((t: string) => t !== 'cron');
      },
      // The firing's room audience: stamp ∨ delivery target ∨ `contextFrom`
      // (`cronFiringAudience`, ./cron-turn.ts — the same rule every runner uses).
      audienceFor: (job: CronJob): Promise<TurnAudience> =>
        cronFiringAudience(job, {
          listJobs: (): Promise<CronJob[]> => scheduler.listJobs(),
          privateChats: privateChatSetFrom(config.gateway?.privateChats),
          warn: (line) => console.warn(line),
        }),
    }),
  });

  // Late-bind the scheduler into the watcher manager (the manager was
  // constructed first so its systemTask handler could ride the scheduler
  // config above). Backing jobs are seeded by `watcherManager.start()` later.
  watcherManager.attachScheduler(scheduler);

  // Cron trigger seam (plan/phases/cron-fire-url-collapse.md, D1). `scheduler`
  // is the `CronEngine`. `ethos gateway` builds no web API, so there is
  // nowhere for `POST /cron/fire` to be mounted and this process can never be
  // fired externally. `hasHttpSurface: false` is therefore passed EXPLICITLY,
  // even though it is the default: it forces the in-process interval on
  // regardless of `cron.fireUrl`, which is the invariant that keeps a fire URL
  // meant for `ethos serve` from silently killing every scheduled job and
  // every cron-backed watcher here. `buildCronTriggers` records why in
  // `notices`, printed below — log and fall through, never throw at boot.
  // `cronTriggers.external` is still constructed and still unused here, now
  // because there is no HTTP surface rather than because of a config flag.
  const cronTriggers: CronTriggers = buildCronTriggers(scheduler, config.cron, {
    hasHttpSurface: false,
  });
  for (const notice of cronTriggers.notices) {
    console.log(`${c.yellow}⚠${c.reset} ${c.dim}${notice}${c.reset}`);
  }
  // Late-bind the arming backend `buildCronTriggers` just produced back onto
  // the scheduler it was built from — see `CronScheduler.setArmingBackend`.
  scheduler.setArmingBackend(cronTriggers.arming);

  // Durable call history (voice V4). Same `~/.ethos/<name>.db` shape as
  // jobs.db / delivery-ledger.db / cards.db, and the SAME file `ethos serve`
  // reads the Communications call list from. Opened only when a trunk is
  // configured: a deployment with no phone number has no calls, and an empty
  // SQLite file it never reads is still a file it has to back up.
  //
  // Opened HERE, ahead of every loop, because the outbound `call` tool writes to
  // it too — one instance shared by the inbound dispatcher below and by every
  // bot's `call` tool, so both directions land in one file through one
  // connection.
  const sipTrunkConfig = config.voice?.trunk;
  const callLog = sipTrunkConfig
    ? new SQLiteCallLog({ path: join(ethosDir(), 'calls.db') })
    : undefined;

  // The approval outbox (Part 2, plan/phases/trust-before-reach.md). Opened
  // AHEAD of every loop because each one's `send_message` gate is built from
  // it: a personality whose `outbound_policy.approve_before_send` is on queues
  // its publications here instead of sending them.
  //
  // `approverFor` is late-bound through `outboxApproverLookup` below, and the
  // lookup is only ever called from inside a tool call, which is long after
  // that. Reading `seamPersonalities` live is what makes a policy edited on
  // disk apply on the next call rather than the next restart.
  let outboxApproverLookup: ((personalityId: string) => string | undefined) | undefined;
  // O-T7/O-T8. Every seam the approval surface needs — the system loop the
  // review turn runs on, the adapter that DMs the card, the registry that says
  // whether the approver exists — is built further down, so the surface is
  // constructed here (the proposal hook needs it) and reads them late.
  let outboxSurface: OutboxApprovalSurface | undefined;
  let outboxCardAdapters: Map<string, OutboxCardCapableAdapter> | undefined;
  const botSpeakers = buildBotSpeakers(config);
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
    ownerTarget: (platform) => config.channelFilter?.[platform]?.ownerUserId,
    approverFor: (personalityId) => outboxApproverLookup?.(personalityId),
    // Fire-and-forget: the item IS queued, so a review or a card that fails
    // costs the operator a Telegram convenience, never the publication.
    onProposed: (item, created) => outboxSurface?.proposed(item, created),
    logger: new ConsoleLogger({}, logLevel),
  });

  // The durable card map (`~/.ethos/outbox-cards.json`). `OutboxItem` has no
  // card columns, and without this a restart between a tap and a delivery
  // leaves the operator's card reading "Approved — sending…" for good.
  const outboxCardRefs = await loadOutboxCardRefs(
    getStorage(),
    join(ethosDir(), OUTBOX_CARDS_FILE),
    new ConsoleLogger({}, logLevel),
  );
  outboxSurface = createOutboxApprovalSurface({
    service: outbox.service,
    reviewer: createOutboxReviewer({
      service: outbox.service,
      // The SAME loop cron's `runJob` fires on. Assigned below; a review only
      // ever runs from inside a tool call, which is long after that.
      loop: () => systemLoop,
      hasPersonality: (id) => seamPersonalities.get(id) != null,
      logger: new ConsoleLogger({}, logLevel),
    }),
    adapterFor: (botKey, platform) => {
      const adapter = outboxCardAdapters?.get(botKey);
      // Never a sibling bot on the same platform: the card is DM'd by the
      // account whose name is on it (the F08 rule, on the approval side).
      return adapter?.id.startsWith(`${platform}:`) ? adapter : undefined;
    },
    ownerTarget: (platform) => config.channelFilter?.[platform]?.ownerUserId,
    cardRefs: outboxCardRefs,
    logger: new ConsoleLogger({}, logLevel),
  });

  // Build one AgentLoop per configured bot. Personality bots use
  // `createAgentLoop`; team bots use `createTeamAgentLoop`. Each loop
  // receives the shared `scheduler` so its `cron` tool lands in the
  // same scheduler store as everything else.
  // Late-bound on purpose: the loops are built here, but the Gateway is
  // constructed further down. Assigned right after construction, and read by
  // two things — the approval-route hooks, and the thread resolver below. A
  // background job spawned by `delegate_task` stamps the turn's thread so its
  // completion (possibly only delivered after a restart) returns to the
  // sub-conversation that asked for it.
  let gatewayRef: Gateway | null = null;
  const {
    bots,
    messagingSetters: botMessagingSetters,
    notificationRouters: botNotificationRouters,
    toolRegistries: botToolRegistries,
    refreshers: botPersonalityRefreshers,
    disposers: botLoopDisposers,
  } = await buildGatewayBots(
    config,
    scheduler,
    watcherManager,
    gatewayTurnOrigin(() => gatewayRef),
    callLog,
    outbox.wiring,
  );

  // Phase 3: for each team-bound bot, ensure the supervisor is running.
  const supervisorDeps: TeamSupervisorDeps = {
    readRuntime,
    removeRuntime,
    isPidAlive,
    spawn,
    kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
  };
  const entryPoint = process.argv[1] ?? '';
  const supervisorResults = await ensureTeamSupervisors(bots, entryPoint, supervisorDeps);
  for (const [teamName, result] of supervisorResults) {
    if (result.status === 'spawned' && result.pid === undefined) {
      console.log(
        `${c.yellow}⚠ team supervisor${c.reset} ${c.bold}${teamName}${c.reset} ${c.yellow}spawned but did not publish a runtime file — team routing may be broken. Run 'ethos team status ${teamName}' to diagnose.${c.reset}`,
      );
    } else {
      console.log(
        result.status === 'spawned'
          ? `${c.dim}team supervisor${c.reset} ${c.bold}${teamName}${c.reset} ${c.dim}spawned (PID ${result.pid})${c.reset}`
          : `${c.dim}team supervisor${c.reset} ${c.bold}${teamName}${c.reset} ${c.dim}already running (PID ${result.pid})${c.reset}`,
      );
    }
  }
  // Native LiveKit media, resolved ONCE and only when telephony/LiveKit is
  // configured. The binding is threaded into the SYSTEM loop alone: that is the
  // loop whose `voiceStack` the SIP dispatcher below uses, and a per-bot loop's
  // stack is never asked for a media transport. One import, one stack that can
  // actually answer.
  const telephonyMedia = await resolveTelephonyMedia(config.voice);
  for (const line of telephonyMedia.lines) console.log(line);

  // System loop used by cron — not bot-bound. Cron jobs route through
  // their own `job.personalityId` field, not through the platform bot
  // routing table. The scheduler is passed in so agent-callable cron
  // tools register against the same instance the firing engine uses.
  const {
    loop: systemLoopReady,
    toolRegistry: systemToolRegistry,
    setMessagingSend: setSystemMessagingSend,
    pluginLoader,
    notificationRouter: systemNotificationRouter,
    activePersonality,
    sttProviders,
    ttsProviders,
    voiceConfig,
    // Telephony (voice V4 E1). Absent unless `config.voice.*` is configured —
    // the whole SIP block below is a clean no-op without it.
    voiceStack,
    refreshPersonalities: refreshSystemPersonalities,
    // Call capture (plan/phases/call-capture-extension.md, "Phase 4 —
    // Integration"). `isCallCaptureToolsEnabled` gates this on
    // darwin + `callCapture.personalityId` regardless of which personality
    // the system loop itself is "for" — `runCallCapture` is invoked with an
    // explicit `personalityId` argument at call time (see the daemon
    // construction below), so any loop's `createAgentLoop()` call produces
    // an equivalent closure. Absent on every other deployment.
    runCallCapture: runCallCaptureFromLoop,
    // The smart approver's decision site (plan decision-provider-jev §8.2).
    // The PROVIDER half of `decisions.*` (provider, key, budgets, thresholds)
    // is operator-level — identical for every loop this process builds — so
    // the process's shared approval predicates (the unattended gate below and
    // `wireApprovalFlow`'s) take THIS build's, the one built from the default
    // config, exactly as they already take the operator's `createLLM(config)`
    // / `config.model` for the LLM reviewer. The MODE is not shared: it is
    // resolved per call inside the approver from the personality the
    // predicate resolved for that session (plan decision-provider-personality
    // §7.3). Absent → the LLM reviewer only (no `decisions.*`).
    approverDecision,
    dispose: disposeSystemLoop,
    // Where each personality's shell tools run in this process — the approval
    // predicates below flag them under a host-local posture (S6 / D1(a)).
    executionPostureFor,
    // …and meter their smart reviewer on this build's ledger.
    usageMeter,
    jobStore: systemJobStore,
    backgroundExecutor: systemBackgroundExecutor,
    jobControl: systemJobControl,
  } = await createAgentLoop(config, {
    cronScheduler: scheduler,
    watcherManager,
    ...(callLog ? { callLog } : {}),
    ...(telephonyMedia.livekit ? { livekit: telephonyMedia.livekit } : {}),
    // Cron, dreams and watcher wakes run here, and a gated personality's
    // `send_message` must queue from this loop exactly as it does from a bot's.
    outbox: outbox.wiring,
    // No bot configured: this loop is also the idle gateway bot's (`idleGatewayBotLoopOpts`); `originBotKey` wins in `resolveJobAffinity`.
    jobAffinity: 'gateway',
    ...(bots.length === 0 ? idleGatewayBotLoopOpts(gatewayTurnOrigin(() => gatewayRef)) : {}),
  });
  systemLoop = systemLoopReady;

  // Cron, dreams, watcher wakes, call capture and SIP-inbound turns run on the
  // systemLoop, and no human is present on it to answer an approval prompt
  // (`wireApprovalFlow` below covers bot loops only). A call that would need approval is therefore
  // REFUSED here, unless the personality declares `approvalMode: off` AND the
  // operator set `allowUnattendedDangerousTools: true`. The same predicate's
  // spoken-confirmation wrapper refuses a SIP far-end caller's consequential
  // request. Pinned by `../__tests__/unattended-approval-gate.test.ts`.
  //
  // With no bot configured this loop is also the idle gateway bot's, so plugin
  // channel turns (remote senders) run here too. Those never get the opt-in:
  // `isRemoteSenderTurn` is true exactly while the gateway holds an approval
  // route for the session — set by `Gateway.runTurn` for its own channel turns
  // only — and the gate then refuses with the bot loops' no-surface text
  // (`createNoApprovalSurfaceGate`). `gatewayRef` is null only before the
  // gateway exists, when no channel turn can be running.
  wireUnattendedApprovalGate(systemLoopReady.hooks, {
    personalities: seamPersonalities,
    reload: () => seamPersonalities.loadFromDirectory(personalitiesDir),
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    allowUnattendedDangerousTools: config.allowUnattendedDangerousTools === true,
    isRemoteSenderTurn: (sessionId) => gatewayRef?.resolveApprovalRoute(sessionId) !== undefined,
    executionPostureFor,
    usageMeter,
    ...(approverDecision ? { decision: approverDecision } : {}),
  });
  // Say so at boot, once, for every personality whose cron jobs can reach a
  // tool that gate refuses — before the first job fails.
  const cronExposure = reportUnattendedCronExposure({
    jobs: await scheduler.listJobs().catch(() => []),
    getPersonality: (id) => seamPersonalities.get(id),
    allowUnattendedDangerousTools: config.allowUnattendedDangerousTools === true,
    executionPostureFor,
    recordSafetyBlock: (event) => getEthosObservability().recordSafetyBlock(event),
  });
  for (const { personalityId, tools } of cronExposure) {
    console.log(
      `${c.yellow}⚠ cron${c.reset} ${c.bold}${personalityId}${c.reset} ${c.yellow}can reach ${tools.join(', ')}, which cron refuses unattended (set safety.approvalMode: off on the personality and allowUnattendedDangerousTools: true in config.yaml to pre-authorize)${c.reset}`,
    );
  }

  // Personality-directory seam for hot-reload. `refresh()` reloads every loop
  // registry (system + per-bot) plus a dedicated read registry from disk, so a
  // personality dropped into or edited under `~/.ethos/personalities/` is
  // usable on the next turn/command without a restart. `has()`/`list()` read
  // the dedicated registry, which `refresh()` keeps in sync with the same disk
  // the loops resolve against (`seamPersonalities`, built above the watcher
  // manager).
  // The outbox's advisory-reviewer lookup.
  // `seamPersonalities` is the one `personalityDirectory.refresh()` reloads, so
  // a changed `approver_personality` is picked up without a restart (O-D4).
  outboxApproverLookup = (personalityId) =>
    seamPersonalities.get(personalityId)?.outbound_policy?.approver_personality;

  const personalityRefreshers = [refreshSystemPersonalities, ...botPersonalityRefreshers];
  // Debounce window: at burst scale, re-scan disk at most once per interval. The
  // mtime-fingerprint cache already makes a no-change scan cheap (~stat per
  // file), and this bounds the per-turn syscall cost when many turns land in
  // quick succession. A dropped/edited personality becomes visible within one
  // window (sub-second), which is well inside human command latency.
  const REFRESH_DEBOUNCE_MS = 300;
  let lastRefreshMs = 0;
  const personalityDirectory = {
    refresh: async (): Promise<void> => {
      const now = Date.now();
      if (now - lastRefreshMs < REFRESH_DEBOUNCE_MS) return;
      lastRefreshMs = now;
      // allSettled, not all: one malformed personality directory (bad YAML) must
      // not sink every other registry's refresh — every registry applies the
      // directories that parsed and serves last-good for the one that didn't.
      const results = await Promise.allSettled([
        seamPersonalities.loadFromDirectory(personalitiesDir),
        ...personalityRefreshers.map((fn) => fn()),
      ]);
      // N3 (ux-feedback-and-config-clarity) — name each failure and each
      // reload instead of a bare count. All registries read the same disk, so
      // the seam registry's lastLoadReport describes what happened to every
      // one of them; a rejected refresher arm with an empty seam report (a
      // storage-level failure, not a per-directory parse) falls back to the
      // old count line so nothing goes unreported.
      const report = seamPersonalities.lastLoadReport;
      for (const failure of report.failures) {
        console.warn(`[personality] ${failure.id}: ${failure.error} — serving last-good copy`);
      }
      for (const reload of report.reloaded) {
        console.log(`[personality] ${reload.id} reloaded (${reload.changed.join(', ')} changed)`);
      }
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0 && report.failures.length === 0) {
        console.warn(
          `[gateway] personality refresh: ${failed}/${results.length} registries failed to reload (serving last-good)`,
        );
      }
    },
    has: (id: string): boolean => seamPersonalities.get(id) != null,
    // Per-personality voice for channel TTS. Read from the SAME registry the
    // refresh above reloads, so an edited `voice.tts_voice` is audible on the
    // next spoken reply without a restart.
    voice: (id: string) => seamPersonalities.get(id)?.voice,
    // Channel presence (plan personality-presence-and-initiative §3): the
    // name and `display.emoji` the reply prefix, receipt reaction and
    // mention-by-name read — from the same refreshed registry.
    identity: (id: string) => {
      const p = seamPersonalities.get(id);
      return p
        ? { name: p.name, ...(p.display?.emoji ? { emoji: p.display.emoji } : {}) }
        : undefined;
    },
    list: (): Array<{ id: string; name: string; isDefault: boolean }> => {
      const defaultId = seamPersonalities.getDefault().id;
      return seamPersonalities.list().map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.id === defaultId,
      }));
    },
  };

  // Idle-triggered background maintenance ("dreaming"). Opt-in per personality:
  // a personality with no `dreaming` block — or `enable: false` — is skipped on
  // every tick, so there is no LLM turn and no cost. The executor owns the whole
  // policy (idle threshold, rolling daily cap, cancel-on-user-activity); this
  // wiring only supplies its three collaborators and drives start/stop.
  //
  // Dreams run on `systemLoop`, the same not-bot-bound loop cron fires through:
  // the turn resolves its personality (and therefore its memory scope) from the
  // `personalityId` passed per run, and its output is maintenance, never a
  // channel reply. Config is read through `seamPersonalities`, which
  // `personalityDirectory.refresh()` reloads before every turn — so switching
  // `dreaming.enable` on disk takes effect without a gateway restart.
  const dreamExecutor = new DreamExecutor(
    getStorage(),
    () => systemLoop ?? undefined,
    (personalityId) => seamPersonalities.get(personalityId),
  );
  const onUserTurn = ({ personalityId }: { personalityId: string }): void => {
    try {
      dreamExecutor.recordUserTurn(personalityId);
    } catch {
      // Unsafe personality id — skip the activity stamp. Dreaming is
      // best-effort background maintenance and must never break a live turn.
    }
  };

  // A2A Stage 1d: register the outbound `a2a_send` tool on every gateway loop's
  // tool registry (per-bot loops + the system loop), so an A2A call can
  // originate from a channel turn — not just from `ethos serve`. The gateway is
  // a separate process with no live settings flag, so the tool follows the
  // persisted `config.a2a.enabled` value (mirrors serve's `ETHOS_A2A_ENABLED`
  // override for parity); a toggle reaches it on the next gateway start (plan
  // §13). Fail-open: a failure constructing the A2A deps must NOT crash gateway
  // startup — channels are the gateway's core job.
  await registerA2aOutboundTools(config, [...botToolRegistries, systemToolRegistry]);

  // Resolve the active personality's plugin allowlist for the trust gate.
  // If the personality declares `plugins:`, only those are trusted; if it
  // doesn't, all plugins are allowed (backward compat — trustedChannelPlugins
  // stays undefined).
  const trustedChannelPlugins = activePersonality?.plugins
    ? new Set(activePersonality.plugins)
    : undefined;

  // Gap 10 — every loop (per-bot + system) owns its own NotificationRouter,
  // and `process_complete` hooks fire on the owning loop's instance. The
  // Gateway holds a single router reference, so fan registrations out to all
  // of them; whichever loop's hook fires finds the same per-session adapter.
  const allNotificationRouters = [...botNotificationRouters, systemNotificationRouter];
  const gatewayNotificationRouter: NotificationRouter = {
    // Registrations are mirrored on every router, so routing through the
    // first reaches the same adapter set — fanning route() out would
    // double-send.
    route: (pluginId, opts) =>
      allNotificationRouters[0]?.route(pluginId, opts) ?? Promise.resolve(),
    register: (sessionKey, adapter) => {
      for (const r of allNotificationRouters) r.register(sessionKey, adapter);
    },
    deregister: (sessionKey) => {
      for (const r of allNotificationRouters) r.deregister(sessionKey);
    },
  };

  // Shared attachment cache for all platform adapters. Hoisted here so the
  // same instance flows into both `buildAdapters` (Telegram, Slack) and the
  // `Gateway` (cleanup on /new and lane eviction).
  const { attachmentCache, pruneTimer } = await createGatewayAttachmentCache(storage);

  // Build and register all configured adapters early so we can wire the
  // clarify surfaces *before* constructing the Gateway. The surfaces' combined
  // `correlateMessage` is passed in as `clarifyMessageCorrelator`. The
  // surface's `getSessionRouting` closes over a mutable holder filled in
  // right after Gateway construction — necessary because the surface and the
  // Gateway each need a reference to the other.
  const adapters = await buildGatewayAdapters(config, attachmentCache);
  warnEmailSenderAuthUnconfigured(config);

  // O-T8 — outbox approval cards. Keyed by the botKey each adapter speaks as
  // (the SAME derivation the Gateway's own routing table uses), because a
  // publication's card is DM'd by the bot that will publish it. Registering the
  // tap handler here rather than after `start()` only fills a handler slot; the
  // owner and revision checks behind it live in `../lib/outbox-wiring`.
  outboxCardAdapters = new Map(
    [...adapterRegistries(adapters).botAdapters].flatMap(([botKey, adapter]) =>
      isOutboxCardCapable(adapter) ? [[botKey, adapter] as const] : [],
    ),
  );
  wireOutboxCardAdapters(outboxSurface, adapters);

  const { clarifyMessageCorrelator } = await registerGatewayClarifySurfaces({
    bots,
    adapters,
    systemLoop,
    resolveApprovalRoute: (sessionId) => gatewayRef?.resolveApprovalRoute(sessionId),
  });

  // Fix 4 (pi-delegation.md §1b) — rebuild each bot's lane bookkeeping for
  // rows that survived a restart. Must run AFTER every clarify surface
  // above has registered its presenter — `hydrate()` only adopts rows this
  // bridge can actually present. Best-effort: a hydration failure must not
  // block gateway startup.
  for (const b of bots) {
    void b.loop.clarifyBridge?.hydrate().catch(() => {});
  }

  // Telegram personality card reader + greeting provider — wired when any
  // Telegram adapter is configured. The card reader powers `/personality rich`;
  // the greeting provider powers `/start`.
  const hasTelegram = adapters.some((a) => a.id.startsWith('telegram:'));
  const telegramCardReader = hasTelegram ? await createTelegramPersonalityCardReader() : undefined;
  const telegramGreetingProvider = hasTelegram ? await createTelegramGreetingProvider() : undefined;

  // ---------------------------------------------------------------------------
  // Chapter 1 safety: channel filter fail-closed assertion + pairing DB init
  // ---------------------------------------------------------------------------
  // If any channel adapter is configured but channel_filter is missing, refuse
  // to boot. This prevents an unchecked gateway from accepting messages from
  // anyone reachable by the bot.
  if (adapters.length > 0 && !config.channelFilter) {
    console.error(
      `${c.red}FATAL: Channel adapters configured without channel_filter safety config.${c.reset}\n` +
        'Add channel_filter.<platform>.ownerUserId to config.yaml for each platform.\n' +
        'See: https://docs.ethos.dev/security/channel-filter',
    );
    process.exit(1);
  }
  // Per-platform assertion: every active adapter must have a matching entry.
  for (const adapter of adapters) {
    const platform = adapter.id.includes(':') ? adapter.id.split(':')[0] : adapter.id;
    if (config.channelFilter && !config.channelFilter[platform]) {
      console.error(
        `${c.red}FATAL: Adapter "${adapter.id}" has no channel_filter.${platform} config.${c.reset}\n` +
          `Add channel_filter.${platform}.ownerUserId to config.yaml.`,
      );
      process.exit(1);
    }
  }

  // Initialize the pairing DB when channel filter is configured. The SQLite
  // file lives alongside the main ethos state at ~/.ethos/pairing.db.
  let pairingDb: InstanceType<typeof Database> | undefined;
  if (config.channelFilter) {
    const dbPath = join(ethosDir(), 'pairing.db');
    pairingDb = new Database(dbPath);
    pairingDb.pragma('journal_mode = WAL');
    initPairingDb(pairingDb);
  }

  // Durable delivery-obligation ledger (item 9). One SQLite file alongside the
  // rest of the ethos state; umask default, same posture as jobs.db /
  // sessions.db, which hold the same class of content.
  const deliveryLedger = new SQLiteDeliveryLedger(join(ethosDir(), 'delivery-ledger.db'));
  // U11 — notices held for quiet hours or a lane /mute (`held_notices`).
  const heldNotices = new SQLiteNotifyQueue(join(ethosDir(), 'notify-queue.db'));

  // Durable inbound dedup (plan/phases/telegram-slack-webhook-mode.md §5). The
  // Gateway's in-memory `Set` stays the fast path; this is the backstop it
  // consults on a miss, so a platform retry that lands on a freshly-restarted
  // process is still recognised as the message it already answered. Same file
  // convention and same unconditional construction as the ledger above.
  const inboundDedup = new SQLiteInboundDedupStore(join(ethosDir(), 'inbound-dedup.db'));

  // Inbound spool (plan reach-and-containment §2.2): a write-ahead record of
  // every turn this gateway owes, replayed after a crash. Opened here and in
  // `ethos boot` — `ethos serve` never opens it (D2-15) — and only AFTER the
  // gateway lock above, which is what makes boot-time orphan recovery safe.
  const { inboundSpool, inboundSpoolOptions } = openInboundSpool(config, ethosDir());

  // Observe-mode transcript sink (plan/phases/ambient-group-monitoring.md R1).
  // Deliberately NOT eager like the two stores above: this one is opened on
  // first write, so `channel-transcript.db` appears only once a chat is
  // actually being watched. See `openChannelTranscriptStore`.
  const channelTranscript = openChannelTranscriptStore(join(ethosDir(), 'channel-transcript.db'));

  // W4.1 — funnel stamps at gateway turn completion. The tracker no-ops once
  // stamped, so this is one cheap callback per turn after the first.
  const onTurnComplete = ({ platform }: { platform: string }): void => {
    const funnel = getFunnelTracker();
    void funnel.recordFirstReply();
    void funnel.recordChannelFirstReply(platform);
  };

  // W3.1 — channel streaming draft edits. `display.streaming_edits` in
  // config.yaml (default `dms`: stream in DMs, not group chats).
  const streamingMode = config.displayStreamingEdits ?? 'dms';
  const streamingEdits = { dm: streamingMode !== 'off', group: streamingMode === 'all' };

  // Context-economy Phase 1 — deterministic pre-LLM quick commands. Register
  // ONE `gateway_message` claiming handler per loop the gateway can dispatch
  // to (each bot loop; the system loop only on the single-loop fallback path).
  // Only commands explicitly marked `gateway: true` are exposed to channels,
  // optionally restricted to the platforms in `channels`. Matching is EXACT
  // (`/<name>`, case-sensitive) and the executed command string comes solely
  // from operator config — channel text is never interpolated into the shell.
  const gatewayQuickCommands = Object.entries(config.quick_commands ?? {}).filter(
    ([, qc]) => qc.gateway === true,
  );
  if (gatewayQuickCommands.length > 0) {
    const quickCommandHandler = async (
      payload: GatewayMessagePayload,
    ): Promise<GatewayMessageResult> => {
      const text = payload.text.trim();
      for (const [name, qc] of gatewayQuickCommands) {
        if (text !== `/${name}`) continue;
        if (qc.channels && !qc.channels.includes(payload.platform)) continue;
        if (qc.type === 'reply') return { handled: true, reply: qc.reply };
        // type 'exec' — runs the operator-authored command, zero LLM tokens.
        const result = runQuickCommand(qc.command);
        return { handled: true, reply: formatQuickCommandOutput(result) };
      }
      return { handled: false };
    };
    const quickCommandLoops =
      bots.length > 0 ? new Set(bots.map((b) => b.loop)) : new Set([systemLoopReady]);
    for (const loop of quickCommandLoops) {
      loop.hooks.registerClaiming('gateway_message', quickCommandHandler);
    }
  }

  // Voice-note machinery. Built ONCE and handed to whichever Gateway the
  // branch below constructs — a second store would mean two caches over the
  // same file and two artifact dirs over the same bytes.
  const { voiceModeStore, transcoder, voiceArtifacts, channelVoiceOut, voiceBitrateKbps } =
    buildGatewayVoiceOutputs(config, storage);

  const gateway: Gateway = buildGateway({
    config,
    bots,
    systemLoop,
    idleBotJobs: {
      jobStore: systemJobStore,
      backgroundExecutor: systemBackgroundExecutor,
      jobControl: systemJobControl,
    },
    adapters,
    deliveryLedger,
    inboundDedup,
    heldNotices,
    inboundSpool,
    inboundSpoolOptions,
    resolveUserId,
    pluginLoader,
    trustedChannelPlugins,
    notificationRouter: gatewayNotificationRouter,
    storage,
    attachmentCache,
    sttProviders,
    ttsProviders,
    voiceConfig,
    voiceModeStore,
    voiceArtifacts,
    transcoder,
    channelVoiceOut,
    voiceBitrateKbps,
    personalityDirectory,
    onTurnComplete,
    onUserTurn,
    streamingEdits,
    pairingDb,
    channelTranscript,
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

  // Wire goal completion notifications back to their originating channel.
  // Each bot's goalRunner fires on that bot's own hooks; register per bot
  // (registries are distinct, so no double-send) plus the system loop for
  // the email/legacy path.
  const sendGoalNote = async (platform: string, chatId: string, text: string): Promise<void> => {
    await gateway.sendTo(platform, chatId, text);
  };
  /** The system loop's goal-note hooks, released on the way out with its runtime. */
  const goalNoteCleanups: Array<() => void> = [];
  // F06 — the hooks go on a BORROWED registry (the loop's), so each
  // registration's cleanup is kept and run with that loop's own release.
  for (const bot of bots) {
    const off = registerGoalNotifications(bot.loop.hooks, sendGoalNote);
    botLoopDisposers.unshift(async () => off());
  }
  if (systemLoop) {
    const offSystemGoalNotes = registerGoalNotifications(systemLoop.hooks, sendGoalNote);
    goalNoteCleanups.push(offSystemGoalNotes);
  }

  // Wire send_message tool to the real Gateway send path.
  // Each loop's messaging send function is scoped — set on all active loops.
  //
  // `sendAsBot`, not `sendTo` (B-T4): the tool call comes out of a turn, and a
  // turn on a channel lane names the bot it speaks as. `sendTo` would resolve
  // the platform's FIRST adapter, so with two Telegram bots configured one
  // agent's `send_message` leaves through the other's identity.
  const gatewayMessagingSend: MessagingSendFn = async (platform, target, body, botKey) =>
    gateway.sendAsBot(platform, target, body, botKey);
  setSystemMessagingSend(gatewayMessagingSend);
  for (const setter of botMessagingSetters) {
    setter(gatewayMessagingSend);
  }

  // Wire cron delivery through the gateway's sendTo path so origin-bearing
  // jobs route output back to the channel they were created from. The binding
  // re-check and the throw-on-failure rule live in `createCronDeliver` — ONE
  // module, shared with `ethos boot` (B-T5).
  const speaksFor = buildChannelSpeakers(config);
  cronDeliverFn = createCronDeliver({ gateway, speaksFor });

  // Watcher deliver → the gateway's sendTo path. sendTo already routes
  // through the outbound dedup cache — the watcher layer adds NO dedup of
  // its own (CLAUDE.md adapter contract). Targets are explicit
  // platform+chatId, never a captured origin.
  watcherDeliverFn = async (target, text) => {
    await gateway.sendTo(target.platform, target.chatId, text);
  };

  // Watcher wake → synthesize an InboundMessage into the owning
  // personality's lane, the way webhook wake does. The diff summary is
  // external observation — wrap it as untrusted content and sanitize the
  // assembled prompt before it enters the loop (same treatment as the cron
  // precheck path). The capturing adapter's reply is intentionally discarded:
  // a woken agent acts through its tools (send_message etc.), not through
  // the synthetic inbound's reply surface.
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

  // Index bots by botKey so health-check lines can show the binding inline.
  const botByKey = new Map(bots.map((b) => [b.botKey, b]));

  if (adapters.length === 0) {
    console.log(
      `${c.dim}No adapters started — gateway idling. Configure a platform to activate.${c.reset}`,
    );
  }

  // Wire all adapters → gateway. Every adapter (Telegram, Slack, Discord,
  // Email, WhatsApp) stamps `InboundMessage.botKey` from the `botKey` field
  // passed at construction — computed once in wiring — and every one is
  // registered as a bot in `buildGatewayBots`, so inbound routes to the
  // matching loop instead of dropping at the unknown-botKey gate.
  //
  // `acceptInbound` first, synchronously: it is the dedup check plus the
  // inbound-spool write. The adapter calls this callback from inside the
  // platform framework's request handler in webhook mode (grammy's
  // `webhookCallback`, Bolt's `HTTPReceiver`), so the row is on disk before
  // that handler returns and the framework acknowledges the webhook — the
  // platform retries only what was never spooled (plan §2.5, D2-10).
  // The durable lane → session map (plan openclaw-9.5-adoption D28), loaded
  // BEFORE any adapter is wired or started and before `startInboundSpoolReplay`
  // below: a replayed row, an interrupted `retry` and a `wake_review` turn all
  // resolve `sessionKeys`, and an empty map would run them in the lane's
  // default session instead of the one `/new` / `/fork` / `/branch` left it on.
  await gateway.restoreLaneSessions();
  for (const adapter of adapters) wireAdapterInbound(gateway, adapter);

  // Wire the tool-approval gate on every bot loop. A bot with a card-capable
  // adapter (Slack, Telegram, Discord) suspends a dangerous call until the
  // user clicks Allow / Deny; every other bot refuses it, because its chat
  // surface cannot show a prompt (see `wireApprovalFlow`).
  const approvalFlow = wireApprovalFlow(gateway, bots, adapters, {
    personalities: seamPersonalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    ...(config.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: config.approvalTimeoutMs }
      : {}),
    ownerFor: (platform) => config.channelFilter?.[platform]?.ownerUserId,
    executionPostureFor,
    usageMeter,
    ...(approverDecision ? { decision: approverDecision } : {}),
  });

  // Start the cron scheduler that was hoisted above (so agent-callable
  // cron tools register against the same instance the firing engine
  // uses). At this point `systemLoop` is assigned, so the deferred
  // `runJob` closure can safely run.
  cronTriggers.local?.start();
  console.log(`${c.dim}Cron scheduler running (checks every 60s)${c.reset}`);

  // Idle checks for dreaming. The interval is unref'd, so it never holds the
  // process open; personalities that don't opt in cost one map lookup a tick.
  dreamExecutor.start();

  // Langfuse export poller (Part E) — opt-in, off by default.
  let langfusePoll: LangfusePollLoop | null = null;
  const langfuseCfg = config.telemetry?.export?.langfuse;
  if (langfuseCfg?.enabled) {
    // D14 (otlp-export): one line, once, at start — release N+1 removes the package.
    console.warn('telemetry.export.langfuse is deprecated; see extensions/export-otlp/README.md');
    if (!langfuseCfg.baseUrl || !langfuseCfg.publicKey || !langfuseCfg.secretKey) {
      console.error(
        '[langfuse-export] telemetry.export.langfuse.enabled is true but baseUrl/publicKey/secretKey ' +
          'are not all set — not starting the export poller.',
      );
    } else {
      langfusePoll = new LangfusePollLoop({
        store: getObservabilityStore(),
        baseUrl: langfuseCfg.baseUrl,
        publicKey: langfuseCfg.publicKey,
        secretKey: langfuseCfg.secretKey,
        onError: (err) => console.warn(`[langfuse-export] tick error: ${err.message}`),
      });
      langfusePoll.start();
      console.log(`${c.dim}Langfuse export poller running (${langfuseCfg.baseUrl})${c.reset}`);
    }
  }

  // OTLP export poller (otlp-export §4.4) — opt-in, off by default. OTel env
  // vars override values but never enable export (D8), so a disabled
  // resolution while config says `enabled: true` is worth one warning naming
  // the deciding input.
  let otlpPoll: OtlpPollLoop | null = null;
  const otlpCfg = config.telemetry?.export?.otlp;
  const otlpSettings = resolveOtlpSettings(otlpCfg, process.env, {
    serviceVersion: buildVersionInfo().version,
  });
  if ('disabled' in otlpSettings) {
    if (otlpCfg?.enabled === true) {
      console.warn(`[otlp-export] not starting: ${otlpSettings.reason}`);
    }
  } else {
    otlpPoll = new OtlpPollLoop({
      store: getObservabilityStore(),
      settings: otlpSettings,
      // D12 — the per-personality `safety.observability.exportTraces` gate,
      // read live from the same registry the loops resolve against. An
      // unknown/deleted personality is allowed: its opt-out cannot be read.
      isExportAllowed: (id) =>
        id == null || seamPersonalities.get(id)?.safety?.observability?.exportTraces !== false,
      onError: (err) => console.warn(`[otlp-export] tick error: ${err.message}`),
    });
    otlpPoll.start();
    console.log(`${c.dim}OTLP export poller running (${otlpSettings.tracesUrl})${c.reset}`);
  }

  // Load watchers.json and seed the backing `source:'system'` tick jobs.
  // Idempotent — existing jobs are re-registered so interval edits apply.
  void watcherManager.start().catch((err) => {
    console.error('[watcher] failed to start watcher manager:', err);
  });

  // Reconcile the system cron jobs against config (plan D7). Not just a
  // seeder: a schedule edited in config.yaml is patched onto the existing job,
  // and a feature switched off has its job removed instead of firing forever.
  // Only the jobs in that table are touched — watcher ticks are seeded per
  // watcher by the watcher manager and are left alone.
  void seedAllSystemJobs(scheduler, config, 'gateway')
    .then((outcomes) => {
      for (const o of outcomes) {
        const problem = systemJobProblem(o);
        if (problem) console.error(`[cron] ${problem}`);
      }
    })
    .catch((err) => {
      console.error('[cron] system job reconciliation failed:', err);
    });

  // Start all adapters — one failing adapter must not stop the rest (UBP-010),
  // and a failed one is retried in the background until it starts, fails
  // permanently, or `shutdown` aborts `adapterStartRetry` (V-CC-4). One that
  // recovers after the platform-webhook mounts below were built is mounted by
  // `onAdapterRecovered`, assigned there.
  const adapterStartRetry = new AbortController();
  let onAdapterRecovered: (adapter: PlatformAdapter) => void = () => {};
  try {
    await startAdaptersIsolated(adapters, {
      observability: gatewayObservability(),
      warn: (message) => new ConsoleLogger({}, logLevel).warn(message),
      // `adapters` is the built-ins only; a plugin channel the Gateway
      // started itself still serves when every one of them failed.
      allFailed: gatewayAllFailedPolicy(adapters, gateway),
      retry: {
        signal: adapterStartRetry.signal,
        onStarted: (a) => onAdapterRecovered(a),
        isRetired: (a) => gateway.hasStopped(a),
      },
    });
  } catch (err) {
    // Every adapter failed. A refused credential on each is final (V2-RT-5):
    // exit 78 so a supervisor stops respawning it; anything else rethrows and
    // exits 1 like a crash, which a restart may cure.
    const refusal = adapterStartFailureExitCode(err);
    if (refusal === undefined) throw err;
    console.error(
      `${c.red}Every adapter's credentials were refused (${err instanceof Error ? err.message : String(err)}). Fix the tokens in ~/.ethos/config.yaml (ethos doctor), then start the gateway again.${c.reset}`,
    );
    process.exit(refusal);
  }

  // Durable delivery sweep (item 9). Deliberately AFTER adapter.start(): a
  // sweep against cold adapters would send into nothing while still burning
  // the obligations. Only rows whose botKey this process owns are touched, and
  // the ledger's atomic claim keeps a peer process (gateway vs. serve) from
  // redelivering the same row — an aged `pending` row is not proof of a crash.
  void gateway
    .sweepPendingDeliveries()
    .then(({ redelivered, failed }) => {
      if (redelivered > 0 || failed > 0) {
        console.log(
          `${c.dim}Delivery ledger: redelivered ${redelivered} pending reply(s), ${failed} deferred${c.reset}`,
        );
      }
    })
    .catch((err) => {
      new ConsoleLogger({}, logLevel).warn(`delivery ledger boot sweep failed: ${String(err)}`);
    });
  // Then every 60s, so a reply refused by a transient platform error is retried
  // without a restart (plan openclaw-2026.9.6-gaps R1); `gateway.shutdown` stops it.
  gateway.startDeliverySweep();

  // Inbound spool replay (plan reach-and-containment §2.4) — beside the ledger
  // sweep and for the same reason AFTER adapter.start(): a replayed turn
  // replies through a live adapter. The first call also arms the gateway's 60s
  // replay tick, so a requeue from `ethos gateway spool replay` or the web
  // Deliveries page runs without a restart.
  startInboundSpoolReplay(gateway, {
    info: (message) => console.log(`${c.dim}${message}${c.reset}`),
    warn: (message) => new ConsoleLogger({}, logLevel).warn(message),
  });

  // Restore-and-deliver (item 10). A background job that finished while this
  // process was down was written `done`/`failed` and then sat unread — the
  // delivery ledger cannot help, because nothing was ever recorded for it.
  // Runs after adapter.start() for the same reason the ledger sweep does.
  void gateway
    .sweepUndeliveredJobs()
    .then(({ delivered, failed }) => {
      if (delivered > 0 || failed > 0) {
        console.log(
          `${c.dim}Background jobs: announced ${delivered} completion(s) missed while offline, ${failed} deferred${c.reset}`,
        );
      }
    })
    .catch((err) => {
      new ConsoleLogger({}, logLevel).warn(
        `background completion boot sweep failed: ${String(err)}`,
      );
    });

  // The approval-outbox dispatcher (O-T6). AFTER `adapter.start()` for exactly
  // the reason the two sweeps above are: a publication handed to a cold adapter
  // is a human's approval burned on a send that reached nothing.
  //
  // Runs HERE, in the gateway process, because only this process holds
  // adapters. web-api writes decisions into the same `outbox.db` and never
  // touches an adapter, so `ethos boot` (one process) and `serve` + a separate
  // `gateway` behave identically.
  const outboxDispatcher = createOutboxDispatcher({
    service: outbox.service,
    gateway,
    ledger: deliveryLedger,
    // Read live: a bot can join or leave while this process runs, and which
    // rows it may claim changes with it.
    botKeys: () => gateway.listBots().map((bot) => bot.botKey),
    cards: outboxSurface.cards,
    logger: new ConsoleLogger({}, logLevel),
  });
  void outboxDispatcher.start();

  // Retention GC — delivered rows carry message bodies, so they are not kept
  // forever. Prune once at boot, then hourly. Pending rows are never pruned.
  const pruneDeliveryLedger = () => {
    void deliveryLedger.pruneDelivered(Date.now() - DELIVERY_LEDGER_RETENTION_MS).catch((err) => {
      new ConsoleLogger({}, logLevel).warn(
        `delivery ledger retention prune failed: ${String(err)}`,
      );
    });
  };
  // Voice artifacts ride the same schedule: abandon obligations nothing ever
  // delivered, then enforce the total-size cap oldest-first. `void`-ed so a
  // retention failure is a log line, never a dead gateway.
  const pruneVoiceArtifacts = () => {
    void gateway
      .pruneVoiceArtifacts({
        abandonAfterDays: config.voice?.artifacts?.abandonAfterDays ?? 7,
        maxTotalMb: config.voice?.artifacts?.maxTotalMb ?? 512,
      })
      .catch((err) => {
        new ConsoleLogger({}, logLevel).warn(
          `voice artifact retention prune failed: ${String(err)}`,
        );
      });
  };
  // Ended call rows carry whole transcripts, so they age out too. `ringing` and
  // `live` rows are never pruned at any age — they are live state, and a ringing
  // row stuck past the cutoff is a lost hang-up worth seeing, not a row to drop.
  const pruneCallLog = () => {
    void callLog?.pruneEnded(Date.now() - CALL_LOG_RETENTION_MS).catch((err) => {
      new ConsoleLogger({}, logLevel).warn(`call log retention prune failed: ${String(err)}`);
    });
  };
  // Inbound spool retention (D2-11) — see `pruneInboundSpool`.
  const pruneSpool = () =>
    pruneInboundSpool(inboundSpool, {
      observability: gatewayObservability(),
      warn: (message) => new ConsoleLogger({}, logLevel).warn(message),
    });
  pruneDeliveryLedger();
  pruneVoiceArtifacts();
  // Session retention (R9) — see `pruneExpiredSessions`. This process holds no
  // session-store handle of its own (each loop's is inside `createAgentLoop`),
  // so one is opened for the prune and closed after it. `retention` carries
  // the vacuum knobs, which `pruneOldSessions` honours.
  const pruneSessions = () => {
    const store = createSessionStore({
      dataDir: ethosDir(),
      ...(config.retention ? { retention: config.retention } : {}),
    });
    // Incognito 24 h sweep (plan incognito-sessions D7/D8) shares the handle.
    // No card clearing: incognito sessions never persist cards
    // (`ChatService.persistCard`, pinned by web-api chat/__tests__/incognito.test.ts).
    const pruned = pruneExpiredSessions(store, config.retention).catch((err) => {
      new ConsoleLogger({}, logLevel).warn(`session retention prune failed: ${String(err)}`);
    });
    const scrubbed = scrubExpiredIncognito(store).catch((err) => {
      new ConsoleLogger({}, logLevel).warn(`incognito sweep failed: ${String(err)}`);
    });
    void Promise.all([pruned, scrubbed]).finally(() => store.close());
  };
  pruneCallLog();
  pruneSpool();
  pruneSessions();
  const retentionPruneTimer = setInterval(() => {
    pruneDeliveryLedger();
    pruneVoiceArtifacts();
    pruneCallLog();
    pruneSpool();
    pruneSessions();
  }, 3_600_000);
  retentionPruneTimer.unref?.();

  // ffmpeg is optional. Without it the gateway still speaks — it sends the
  // formats the TTS provider already produces and SKIPS the rest rather than
  // handing an adapter a container it declared it cannot play. Say so once, as
  // a notice: a missing optional binary must not read as a failed boot.
  void transcoder
    .available()
    .then((ok) => {
      if (!ok) {
        console.log(
          `${c.yellow}⚠ ffmpeg not found${c.reset} ${c.dim}— voice notes will be delivered only in the formats the TTS provider already produces. Install ffmpeg to enable the rest.${c.reset}`,
        );
      }
    })
    .catch(() => {});

  // Plugins finished loading inside createAgentLoop above; now that the
  // adapters are constructed and started, push plugin slash commands to each
  // platform's command menu (Telegram setMyCommands, Slack, Discord).
  await gateway.pluginsReady();

  // Health checks — include botKey and binding for multi-bot adapters so the
  // startup log shows exactly which bot is live and what it's bound to.
  for (const adapter of adapters) {
    const health = await adapter.health();
    // adapter.id is `${platform}:${botKey}` for telegram/slack; the botKey is
    // everything after the first colon.
    const adapterBotKey = adapter.id.includes(':') ? adapter.id.split(':').slice(1).join(':') : '';
    const bot = botByKey.get(adapterBotKey);
    const bindingSuffix = bot
      ? ` ${c.dim}→ ${bot.binding.type}:${c.reset}${c.bold}${bot.binding.name}${c.reset}`
      : '';
    if (health.ok) {
      const ms = health.latencyMs ? `${c.dim} (${health.latencyMs}ms)${c.reset}` : '';
      console.log(`${c.green}✓${c.reset} ${c.bold}${adapter.id}${c.reset}${bindingSuffix}${ms}`);
    } else {
      console.log(`${c.yellow}⚠ ${adapter.id} health check failed${c.reset}${bindingSuffix}`);
    }
  }

  emitReady('gateway');
  notifyReady();
  const stopWatchdog = startWatchdog();

  const heartbeatStartedAt = new Date().toISOString();

  const healthPort = Number(process.env.ETHOS_GATEWAY_HEALTH_PORT) || 3002;
  const healthHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  // P2-counters (D2/D16) — same rendering pipeline as web-api's `/metrics`
  // (`createMetricsTextProvider`, `renderMetricsText`), so both surfaces
  // serve byte-identical text. `ethos_gateway_adapter_up` reads LIVE adapter
  // health here (this process IS the source of truth for it), not the
  // persisted heartbeat file web-api reads through a staleness gate.
  // The export-lag gauge (`ethos_trace_export_lag_seconds{store="otlp"}`,
  // otlp-export §4.1) renders only while this process runs the otlp sink —
  // on a deployment that never enabled export, `oldestUnexportedStartTs`
  // would count every closed trace as "lag" for a sink that does not exist.
  const gatewayObsStore = getObservabilityStore();
  const gatewayMetricsText = createMetricsTextProvider({
    store: otlpPoll
      ? {
          getMetricCounters: () => gatewayObsStore.getMetricCounters(),
          getExportLag: () => {
            const oldest = gatewayObsStore.oldestUnexportedStartTs('otlp');
            return [
              {
                sink: 'otlp',
                lagSeconds: oldest == null ? 0 : Math.max(0, (Date.now() - oldest) / 1000),
              },
            ];
          },
        }
      : gatewayObsStore,
    getGatewayAdapters: async () => {
      const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
      return hb.adapters.map((a) => ({ adapter: a.name, up: a.ok ? 1 : 0 }) as const);
    },
  });
  // P2-counters (D16/D17) — `/metrics` stays gated by `metrics:read` even
  // when an operator rebinds ETHOS_SERVE_HOST off-loopback, per the
  // monitor-with-grafana how-to. `sessions.db` is already safely shared
  // cross-process (WAL) with `ethos serve` for other purposes, so a second
  // `SqliteApiKeyStore` handle on it here is safe.
  const metricsApiKeys = new SqliteApiKeyStore(join(ethosDir(), 'sessions.db'));
  const eventLoopLag = createEventLoopLagSampler();
  const checkMetricsAuth = createGatewayMetricsAuthCheck(metricsApiKeys);
  const healthServer = createHealthServer(
    healthPort,
    healthHost,
    async () => {
      const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
      return {
        status: gatewayHealthStatus(hb.adapters),
        uptime: process.uptime(),
        pid: hb.pid,
        startedAt: hb.startedAt,
        updatedAt: hb.updatedAt,
        adapters: hb.adapters,
      };
    },
    gatewayMetricsText,
    checkMetricsAuth,
    {
      // R6 — `/readyz`. Adapter health comes through `buildGatewayHeartbeat`,
      // i.e. the 60s `cachedHealth`, so a probe never logs in to IMAP.
      readiness: createReadinessCheck({
        adapters: async () => (await buildGatewayHeartbeat(adapters, heartbeatStartedAt)).adapters,
        sqlitePaths: gatewaySqliteStorePaths(ethosDir()),
        lagP99Ms: eventLoopLag.p99Ms,
      }),
      eventLoopLagP99Ms: eventLoopLag.p99Ms,
    },
  );
  console.log(`  health: http://${healthHost}:${healthPort}/healthz`);
  console.log(`  ready: http://${healthHost}:${healthPort}/readyz`);
  console.log(`  metrics: http://${healthHost}:${healthPort}/metrics`);

  // Inbound webhooks — opt-in: only listen when at least one hook is configured.
  const webhookPort = Number(process.env.ETHOS_WEBHOOK_PORT) || 3003;
  const webhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  // Prefilter scripts run through the same guarded machinery as cron script
  // jobs (`runScriptFile`: ~/.ethos/scripts/ confinement, fixed interpreters,
  // secret-redacted output). Injected as a seam so webhook-server.ts keeps
  // its types-only top-level import surface (daemon-free doctrine).
  const webhookPrefilterBackend = new LocalExecutionBackend({
    config: {},
    secrets,
    logger: new ConsoleLogger({}, logLevel),
  });
  const runWebhookPrefilter: PrefilterRunner = (file, opts) =>
    runScriptFile(
      { file, timeoutSeconds: opts.timeoutSeconds },
      {
        storage: getStorage(),
        executionBackend: webhookPrefilterBackend,
        scriptsDir: ethosScriptsDir(),
        stdin: opts.stdin,
        label: 'prefilter',
      },
    );
  // Delivery fan-out for `deliver` / `deliverOnly` hooks. Injected as a seam
  // for the same reason the prefilter is: `relayToTargets` lives in
  // `@ethosagent/gateway`, which webhook-server.ts may not import. Its own
  // adapter map — line ~3052 builds a different one, keyed by PLATFORM for
  // send_message routing and scoped to another function. This one is keyed by
  // the full `adapter.id`, which is what a `deliver` target names. The ledger
  // is the gateway's existing instance, never a second one: one reliability
  // mechanism, so the boot sweep redelivers a failed fan-out like any reply.
  const webhookRelayAdapters = new Map(adapters.map((a) => [a.id, a as PlatformAdapter]));
  const relayWebhookTargets: DeliveryRelay = (targets, content, ctx) =>
    relayToTargets(targets, content, {
      hookId: ctx.hookId,
      sessionKey: ctx.sessionKey,
      adaptersById: webhookRelayAdapters,
      ledger: deliveryLedger,
      // The relay takes the console as a seam — library code under
      // `extensions/` may not own it. This file is the CLI, where it may.
      log: (line) => console.log(line),
    });
  const webhookServer =
    config.webhooks && Object.keys(config.webhooks).length > 0
      ? createWebhookServer(
          webhookPort,
          webhookHost,
          gateway,
          config.webhooks,
          createCapturingAdapter,
          runWebhookPrefilter,
          relayWebhookTargets,
          {
            // Refused webhook traffic lands in the same safety-block stream
            // `sendTracked` writes to — one place an operator already looks,
            // not a second alerting channel. `Gateway.observability` is
            // private, so this uses the process accessor the Slack clarify
            // surface below wires the identical way. The operator-facing
            // warn line lives in webhook-server.ts, which sees every
            // rejection path; duplicating it here would double every line.
            onRejected: (hookId, reason) =>
              getEthosObservability().recordSafetyBlock({
                code: 'webhook.rejected',
                cause: reason,
                details: { hookId },
              }),
            // D12 — a `private: true` hook runs private only when every
            // deliver target is private too (`webhookAudienceHint`).
            targetAudience: (platform, chatId) =>
              targetAudience(platform, chatId, privateChatSetFrom(config.gateway?.privateChats)),
          },
        )
      : undefined;
  if (webhookServer && config.webhooks) {
    const isLoopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(webhookHost);
    if (!isLoopbackHost) {
      new ConsoleLogger({}, logLevel).warn(
        `webhook bound to non-loopback host ${webhookHost} over plaintext HTTP — ` +
          'the bearer secret is transmitted in cleartext. Put a TLS-terminating ' +
          'proxy in front, or bind to loopback (ETHOS_SERVE_HOST=127.0.0.1).',
      );
    }
    for (const hookId of Object.keys(config.webhooks)) {
      console.log(`  webhook: http://${webhookHost}:${webhookPort}/webhook/${hookId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Telephony — inbound SIP webhook (plan/phases/voice-v4-telephony.md E1/E4)
  // ---------------------------------------------------------------------------
  //
  // NO PLATFORM ADAPTER IS REGISTERED FOR SIP, AND NONE SHOULD BE. The next
  // person to read this will want to push a "sip" entry into `adapters[]` so a
  // call looks like every other channel. Two reasons not to: the `channel_filter`
  // gate above is FATAL for anything in that array, and a phone number has no
  // `ownerUserId` to filter on — the caller is a stranger by definition, which is
  // what the inbound hardening gate exists for instead. And a call is not a chat:
  // it runs on the `VoiceStack` media path with its own lane
  // (`voice:<botKey>:sip:<callerId>`), and the only thing it sends through the
  // channel layer is its post-call summary, which goes out via
  // `gateway.notifyTracked` so it rides the delivery ledger.
  const sipWebhookSecret = sipTrunkConfig?.webhookSecret;
  const sipWebhookPath = sipTrunkConfig?.webhookPath ?? '/sip/inbound';
  // 3002 gateway health, 3003 gateway webhook, 3004 is `ethos run-all`'s health
  // endpoint (ETHOS_RUNALL_HEALTH_PORT) — and run-all SPAWNS this process, so
  // 3004 here would EADDRINUSE on the most common supervised deployment. 3005 is
  // the next free one.
  const sipWebhookPort = Number(process.env.ETHOS_SIP_WEBHOOK_PORT) || 3005;
  const sipWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  let sipWebhookServer: import('node:http').Server | undefined;
  if (sipTrunkConfig && sipWebhookSecret && voiceStack && callLog) {
    const owner = voiceStack.inbound.owner;
    if (!owner) {
      // Said ONCE at startup rather than per call: the operator configured a
      // trunk but nowhere to hear about it, and a summary with no destination is
      // exactly the failure this plan set out to fix. Not fatal — the agent can
      // still answer the phone.
      console.log(
        `${c.yellow}⚠ voice.inbound.owner is not set${c.reset} ${c.dim}— call summaries and refusal notices have nowhere to go. Set voice.inbound.owner.platform / .chatId to receive them.${c.reset}`,
      );
    }
    // Number → personality: the bot's `bind` IS that mapping (no second
    // structure). Team-bound voice bots have no single personality to pin, so
    // they fall through to the loop's default.
    const voiceBotBindings = new Map(
      (config.voice?.bots ?? []).map((bot) => [
        bot.id ?? deriveBotKeyFromSeed(bot.match),
        bot.bind.type === 'personality' ? bot.bind.name : undefined,
      ]),
    );
    const onSipCall = createSipInboundHandler({
      voiceStack,
      callLog,
      loop: systemLoop,
      botPersonalityId: (bot) => voiceBotBindings.get(bot.id ?? deriveBotKeyFromSeed(bot.match)),
      personality: (id) => seamPersonalities.get(id),
      // Through `notifyTracked`, so the notice becomes a durable obligation
      // BEFORE the platform call and the existing boot sweep redelivers it if it
      // failed. Not a second delivery path — the same one every channel reply
      // uses. No owner configured → nothing to deliver to, reported once above.
      notifyOwner: async (text) =>
        owner
          ? gateway.notifyTracked(
              {
                platform: owner.platform,
                chatId: owner.chatId,
                ...(owner.botKey ? { botKey: owner.botKey } : {}),
              },
              text,
            )
          : false,
      onError: (message) => new ConsoleLogger({}, logLevel).warn(`sip: ${message}`),
    });
    sipWebhookServer = createSipWebhookServer({
      port: sipWebhookPort,
      host: sipWebhookHost,
      path: sipWebhookPath,
      provider: sipTrunkConfig.provider,
      secret: sipWebhookSecret,
      onCall: async (call, raw) => {
        await onSipCall(call, raw);
      },
    });
    console.log(`  sip: http://${sipWebhookHost}:${sipWebhookPort}${sipWebhookPath}`);
  } else if (sipTrunkConfig && !sipWebhookSecret) {
    console.log(
      `${c.yellow}⚠ voice.trunk is configured without voice.trunk.webhookSecret${c.reset} ${c.dim}— the inbound call listener stays off. An unsigned webhook is an open line anyone who learns the URL can ring.${c.reset}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Native platform webhooks — Telegram + Slack
  // (plan/phases/telegram-slack-webhook-mode.md §2b, §3c, §4)
  // ---------------------------------------------------------------------------
  //
  // PLACED AFTER `startAdaptersIsolated(adapters, …)` ABOVE, AND THAT IS LOAD-BEARING.
  // `TelegramAdapter.webhook` is `undefined` until `start()` has registered the
  // webhook with Telegram and built grammy's callback; building the dispatch map
  // at adapter-construction time would mount nothing and 404 every delivery.
  //
  // Opt-in, gated on need exactly like the `config.webhooks` block above: with no
  // bot in webhook mode and no app in HTTP mode, no port is bound at all. That is
  // what keeps this additive for every deployment that has not asked for it.
  const platformWebhookMounts = buildPlatformWebhookMounts(config, adapters, (message) =>
    new ConsoleLogger({}, logLevel).warn(message),
  );
  // 3002 gateway health, 3003 gateway webhook, 3004 `ethos run-all` health, 3005
  // SIP — see the SIP block above for why 3004 is not free. 3006 is next.
  const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;
  const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  let platformWebhookServer: import('node:http').Server | undefined;
  const ensurePlatformWebhookServer = (): void => {
    if (platformWebhookServer) return;
    if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;
    // The non-loopback cleartext warning lives inside `createPlatformWebhookServer`
    // (unlike the `config.webhooks` block, which warns at its call site) — it is
    // the server that knows what host it bound.
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
  // now built its webhook handler: mount it in the live table the server reads
  // per request, binding the listener if this is the first route.
  onAdapterRecovered = (adapter) => {
    const mounts = buildPlatformWebhookMounts(config, [adapter], (message) =>
      new ConsoleLogger({}, logLevel).warn(message),
    );
    for (const [botKey, handler] of mounts.telegram)
      platformWebhookMounts.telegram.set(botKey, handler);
    for (const [route, handler] of mounts.slack) platformWebhookMounts.slack.set(route, handler);
    ensurePlatformWebhookServer();
  };

  // Call-capture daemon (plan/phases/call-capture-extension.md, "Phase 4 —
  // Integration"; Architecture Issue B — `ethos gateway` previously had no
  // call-capture wiring at all). Mirrors `serve.ts`'s daemon construction
  // block exactly: same macOS + `callCapture.personalityId` guard, same
  // `MicActivityDetector`/`NotificationGate`/`checkCallCaptureDependencies`,
  // the SAME `watcherWake` closure `WatcherManager` above already uses (not a
  // second copy), and `runCallCaptureFromLoop` from the system loop's
  // `createAgentLoop()` result. A complete no-op (nothing constructed) for
  // every deployment that hasn't set `callCapture.personalityId`.
  // Liveness heartbeat for `ethos doctor`'s `checkCallCaptureDaemonHealth`
  // (mirrors this file's own `gateway-health.json` heartbeat below) — same
  // 10s cadence is reused below as the ownership-claim retry interval too
  // (P0, plan/phases/call-capture-desktop-ux.md — don't invent a second
  // interval).
  let callCaptureOwnershipManager: CallCaptureOwnershipManager | undefined;
  let callCaptureState: { kind: string } = { kind: 'idle' };
  if (
    process.platform === 'darwin' &&
    config.callCapture?.personalityId &&
    runCallCaptureFromLoop
  ) {
    const callCaptureLogger = new ConsoleLogger({}, logLevel);
    // Round-3 Issue 1 — `ethos serve` and `ethos gateway` can both be
    // configured with `callCapture.personalityId` at once (e.g. one under a
    // LaunchAgent, the other under `ethos run-all`, which starts both by
    // default). At most one process may run a live `CallCaptureDaemon`, or
    // they fight over the same Process Tap/mic and stomp each other's
    // shared heartbeat file. Losing the claim is a normal, expected outcome
    // — not an error. `CallCaptureOwnershipManager` logs it and keeps
    // retrying on `CALL_CAPTURE_HEARTBEAT_INTERVAL_MS` until it wins (P0:
    // the previous single-attempt claim left a process permanently
    // daemon-less if it lost the race at launch, even after the winner
    // later exited and released the lock).
    const boundPersonalityId = config.callCapture.personalityId;
    const captureRunner = runCallCaptureFromLoop;
    callCaptureOwnershipManager = new CallCaptureOwnershipManager({
      lockPath: callCaptureLockPath(ethosDir()),
      retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
      logger: callCaptureLogger,
      onOwnershipClaimed: () => {
        const callCaptureDaemon = new CallCaptureDaemon({
          detector: new MicActivityDetector(),
          notificationGate: new NotificationGate(),
          checkDependencies: checkCallCaptureDependencies,
          // No separate process-prefilter gate here — the native detector
          // (extensions/platform-callcapture/native/mic-detector.swift) only
          // ever watches known calling apps in the first place, so every
          // call_started event it produces is already scoped to one, with its
          // resolved source label riding along on the event itself. Known
          // limitation, documented in the package README: this cannot see a
          // browser-based call (e.g. Meet in Chrome).
          personalityId: boundPersonalityId,
          // Private by design: the owner's own call audit trail (`callCaptureWake`).
          wake: callCaptureWake(watcherWake),
          // Floating on-screen recording indicator (plan/phases/
          // call-capture-desktop-ux.md) — the headless-CLI analog of the
          // desktop app's Electron-based pill. Fresh per ownership claim,
          // mirroring detector/notificationGate above.
          indicator: new CaptureIndicator({
            onError: (msg) => callCaptureLogger.warn(`call-capture: ${msg}`),
          }),
          onStateChange: (state) => {
            callCaptureState = state;
          },
          runCapture: async (abortSignal, source, onEntry, onAudioLevel) => {
            const result = await captureRunner(boundPersonalityId, {
              abortSignal,
              source,
              onEntry,
              onAudioLevel,
            });
            if (!result.ok) {
              callCaptureLogger.error(`call-capture: capture failed: ${result.error}`);
              return;
            }
            if (result.warning) callCaptureLogger.warn(`call-capture: ${result.warning}`);
            callCaptureLogger.info(`call-capture: saved transcript to ${result.artifactKey}`);
          },
          logger: callCaptureLogger,
        });
        callCaptureDaemon.start();

        const writeCallCaptureHeartbeat = async () => {
          try {
            await storage.writeAtomic(
              callCaptureHealthPath(ethosDir()),
              JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }),
            );
          } catch {
            // Best-effort — a missed tick is harmless; the consumer treats
            // stale/absent data as degraded.
          }
        };
        void writeCallCaptureHeartbeat();
        const callCaptureHeartbeatTimer = setInterval(
          () => void writeCallCaptureHeartbeat(),
          CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
        );
        callCaptureHeartbeatTimer.unref?.();

        return async () => {
          callCaptureDaemon.stop();
          callCaptureState = { kind: 'idle' };
          clearInterval(callCaptureHeartbeatTimer);
          await storage.remove(callCaptureHealthPath(ethosDir())).catch(() => {});
        };
      },
    });
    callCaptureOwnershipManager.start();
  }

  console.log(`${c.dim}Listening for messages. Press Ctrl+C to stop.${c.reset}\n`);
  let heartbeatInFlight = false;
  const writeHeartbeat = async () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
      await storage.writeAtomic(gatewayHealthPath(), JSON.stringify(hb));
    } catch {
      // Best-effort — a missed tick is harmless; the consumer treats stale
      // data as degraded.
    } finally {
      heartbeatInFlight = false;
    }
  };
  void writeHeartbeat();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Idle watcher — declared here only so `shutdown` can stop its interval.
  // It is CONSTRUCTED below the signal handlers, after every subsystem it
  // reads (plan/phases/idle-watcher.md §5).
  let idleWatcher: IdleWatcherManager | undefined;

  // ONE per process (see `pause-lifecycle.ts`): a `NoopPauseLifecycle` unless
  // the operator enabled `pauseClockCorrection`, in which case it is a started
  // clock-drift detector. Declared here so `shutdown` below can stop its timer.
  const pauseLifecycle = createPauseLifecycle(config);

  // Resume-boundary clock corrections (plan/phases/clock-tolerance-pass.md §3/§4).
  //
  // `runGatewayStart` deliberately does not run the merged boot profile's
  // reconciliation pass (that asymmetry is `ethos boot`'s whole reason to exist,
  // and a sibling test pins this command to its own sweeps at their original
  // call site). So this registration is the ONLY thing that corrects a gate in
  // this process — and this process is the only one that owns two of them: the
  // `DreamExecutor` (gate #12, the one gate that spends real API cost when it
  // misfires, by dreaming for every personality at once on the first post-resume
  // tick) and the `Gateway`'s delivery-ledger abandon window (gate #2, which for
  // a voice obligation DELETES the artifact).
  //
  // ONE job store, not one per bot. Every `createAgentLoop` opens its own
  // `SQLiteJobStore` against the SAME `jobs.db` (`build-agent-loop.ts:933`), so
  // the per-bot handles are N views of one file — bumping each would advance
  // `heartbeat_at` by N × the pause and push live rows into the future. The
  // adjacent `busy-sources` code can map over all of them safely only because it
  // READS; this writes.
  const correctableJobStore = bots.find((b) => b.jobStore !== undefined)?.jobStore;
  pauseLifecycle.onResume?.((pauseDurationMs) => {
    void applyPauseCorrections(
      {
        gateway,
        dreamExecutor,
        ...(hasHeartbeatBump(correctableJobStore) ? { jobStore: correctableJobStore } : {}),
      },
      pauseDurationMs,
      new ConsoleLogger({}, logLevel),
    );
  });

  // Graceful shutdown on SIGINT / SIGTERM. Tell every in-flight chat that the
  // gateway was interrupted so they don't sit waiting on a response that
  // never comes. See plan/IMPROVEMENT.md P1-1.
  // Reentrancy: registered on BOTH SIGINT and SIGTERM, and a second signal
  // during the drain would otherwise re-run the whole teardown. One promise,
  // memoised; every caller awaits that same one (the shape `serve`/`boot` use).
  //
  // Bounded: every await below has a deadline — its own (`approvalFlow`,
  // `gateway.shutdown`, `disposeBeforeExit`) or `boundedShutdownStep`'s — so the
  // ledger/spool closes, the lock release and `process.exit` always run.
  // `ethos run-all` sizes its SIGKILL grace from exactly these bounds
  // (commands/run-all.ts `CHILD_PRE_DISPOSE_DRAIN_MS`, pinned by
  // commands/__tests__/run-all.test.ts).
  let shuttingDown: Promise<void> | undefined;
  const stepReporting = { sink: gatewayObservability, warn: (m: string) => console.warn(m) };
  const shutdown = async (exitCode = 0): Promise<void> => {
    shuttingDown ??= (async () => {
      console.log(`\n${c.dim}Shutting down...${c.reset}`);
      adapterStartRetry.abort();
      if (stopWatchdog) stopWatchdog();
      // Deny + audit any suspended approval FIRST — the coordinator's auto-deny
      // timers are unref'd and never fire on the way out, and a later await
      // that hangs must not cost the audit row or the card update.
      //
      // MUST stay above `adapters.map((a) => a.stop())`: the awaited handle
      // drains the in-flight `updateApprovalCard` calls, and stopping the
      // adapters first would tear out the transport those updates ride on,
      // leaving a denied approval's card showing live Allow/Deny buttons.
      await approvalFlow.shutdown();
      healthServer.close();
      webhookServer?.close();
      sipWebhookServer?.close();
      platformWebhookServer?.close();
      clearInterval(pruneTimer);
      clearInterval(heartbeatTimer);
      clearInterval(retentionPruneTimer);
      idleWatcher?.stop();
      pauseLifecycle.stop?.();
      cronTriggers.local?.stop();
      dreamExecutor.stop();
      langfusePoll?.stop();
      otlpPoll?.stop();
      // Stopped BEFORE the gateway drains: a tick that started now would claim
      // a row this process is about to stop being able to deliver, and leave it
      // `sending` for the ten minutes the stale reconciler waits.
      outboxDispatcher.stop();
      // Reviews and card round trips are started from a fire-and-forget hook,
      // so they are drained explicitly BEFORE the adapters stop — otherwise the
      // transport is torn out from under a card mid-update and an approved
      // publication is left showing live buttons.
      await boundedShutdownStep('outbox drain', () => outboxSurface.drain(), stepReporting);
      await boundedShutdownStep(
        'gateway health file',
        () => storage.remove(gatewayHealthPath()),
        stepReporting,
      );
      // Stops the daemon + heartbeat (if this process ever won the ownership
      // claim, including via a later retry tick — see
      // `CallCaptureOwnershipManager`) and releases the lock so a restarted
      // process, or the other host command, can take it.
      await boundedShutdownStep(
        'call-capture ownership',
        () => callCaptureOwnershipManager?.stop(),
        stepReporting,
      );
      // Bounded by its own `drainTimeoutMs`, notice sends included
      // (`Gateway.shutdown`, extensions/gateway/src/index.ts).
      await gateway.shutdown({
        notify:
          '⚠ Ethos was interrupted while answering. Please resend your last message — your session history is preserved.',
      });
      await boundedShutdownStep(
        'adapters stop',
        () => Promise.allSettled(everyStartedAdapter(adapters, gateway).map((a) => a.stop())),
        stepReporting,
      );
      // F06 — every loop's runtime (background executors, reconcilers, stores,
      // MCP, plugins), once the gateway has drained and nothing routes to them.
      // Before the call log closes: a loop's `call` tool writes through it.
      await disposeBeforeExit(
        [
          ...botLoopDisposers.map((dispose) => ['bot loop', dispose] as const),
          [
            'system loop',
            async () => {
              for (const off of goalNoteCleanups.splice(0)) off();
              await disposeSystemLoop();
            },
          ],
          ['plugin hosts', closeProcessPluginHostPool],
        ],
        (message) => console.warn(message),
      );
      deliveryLedger.close();
      heldNotices.close();
      inboundDedup.close();
      inboundSpool.close();
      // Last of the gateway-owned state: from here a new gateway may start.
      releaseGatewayLock();
      // After the loops are disposed: a turn still running could propose.
      outbox.close();
      callLog?.close();
      // Observe mode's transcript handle — a no-op when nothing was recorded
      // (`openChannelTranscriptStore` closes only what it opened).
      channelTranscript.close();
      // This process's own `sessions.db` handles: the metrics api-key reader and
      // whatever the Slack App Home readers opened (F06, as `serve`/`boot` do).
      metricsApiKeys.close();
      closeSlackSessionStores();
      stopTeamSupervisors(bots, config.teams ?? {}, supervisorDeps);
      // The process-wide observability store — last, after everything above,
      // which records into it while it winds down.
      closeObservabilityStore();
      process.exit(exitCode);
    })();
    await shuttingDown;
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // A stray rejection is logged and survived; an uncaught exception runs this
  // same bounded shutdown and exits 1 (plan openclaw-2026.9.6-gaps R2).
  installProcessGuards({
    command: 'gateway',
    observability: getEthosObservability,
    shutdown: (exitCode) => shutdown(exitCode),
  });

  // Idle watcher (plan/phases/idle-watcher.md §5) — CONSTRUCTED LAST, after
  // every subsystem its sources read, and only when the operator opted in.
  // Unlike `watchers`/`cron` this is not always-constructed: on a laptop or a
  // bare-metal box there is no host to suspend into, so it should not exist at
  // all in the common case.
  if (config.idleWatcher?.enabled === true) {
    idleWatcher = new IdleWatcherManager({
      sources: buildGatewayBusySources({
        gateway,
        dreamExecutor,
        bots,
        approvalFlow,
        webhookServer,
        cronScheduler: scheduler,
        callCaptureActive: callCaptureOwnershipManager
          ? () => callCaptureState.kind !== 'idle'
          : undefined,
        // Flat layout: `pidFilePath(name)` in @ethosagent/team-supervisor
        // resolves to `<teamsDir()>/<name>.pid`, so this is the dir the PID
        // files it writes actually land in.
        teamsPidDir: teamsDir(),
        outboxPending: outbox.pendingPublications,
      }),
      // The one instance for this process. Its outbound half is still a no-op:
      // a real host adapter that signals a Firecracker-style control plane is a
      // later phase, so the watcher's arming gates are what matter here.
      pauseLifecycle,
      // Flips to `true` when the `pauseLifecycle` above becomes a real host
      // adapter. While it is a no-op, `signalReadyToSuspend()` resolves,
      // latches, and stops the watcher having suspended nothing — so gate 3b
      // refuses to arm rather than accept that as a handoff.
      hostSignalAvailable: pauseLifecycle.hostSignalAvailable ?? false,
      capabilities: deriveIdleWatcherCapabilities(config),
      options: config.idleWatcher,
      logger: new ConsoleLogger({}, logLevel),
    });
    // Fire-and-forget: `start()` evaluates the arming gates itself and is a
    // no-op (with a logged reason) when any of them refuses.
    idleWatcher.start();
  }

  // Gateway is fully up and listening — let the caller print its own ready
  // banner (the W2.5 t.me success block) after all the adapter/health lines.
  opts.onReady?.();

  // Keep the process alive (adapter polling runs async)
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// Phase 1 helpers
// ---------------------------------------------------------------------------

/**
 * Derive the botKey for the legacy scalar Discord config. Computed once here
 * and passed to BOTH the adapter (which stamps it on inbound messages) and
 * `buildGatewayBots` (which registers the routing entry), so the two never
 * drift. Seed is the bot token, matching the pre-P5 adapter derivation so the
 * key value is stable across the change.
 */
export function discordBotKey(discordToken: string): string {
  return deriveBotKeyFromSeed(discordToken);
}

/**
 * Derive the botKey for the legacy scalar Email config. Same contract as
 * `discordBotKey`. Seed is `<user>@<imapHost>`, matching the pre-P5 adapter
 * derivation.
 */
export function emailBotKey(user: string, imapHost: string): string {
  return deriveBotKeyFromSeed(`${user}@${imapHost}`);
}

/**
 * Build the per-bot routing table the Gateway needs. Walks both
 * `config.telegram.bots` and `config.slack.apps`, resolving each
 * binding to either a personality-scoped AgentLoop (`createAgentLoop`)
 * or a team coordinator loop (`createTeamAgentLoop`). The botKey
 * matches what adapters will stamp on inbound messages.
 */
export async function buildGatewayBots(
  config: EthosConfig,
  scheduler: CronScheduler,
  watcherManager: WatcherManager,
  origin: GatewayTurnOrigin,
  callLog?: CallLog,
  /** The approval outbox (`createOutboxRuntime(...).wiring`). Omitted and a
   *  gated personality's `send_message` sends as it always did — which is why
   *  every path that builds a bot has to pass it, hot-added bots included. */
  outbox?: OutboxWiring,
): Promise<BuildGatewayBotsResult> {
  // F06 — a bot that fails to build must not strand the loops built before it
  // (each with a running background executor): release them, then rethrow.
  const disposers: Array<() => Promise<void>> = [];
  try {
    return await assembleGatewayBots(
      config,
      scheduler,
      watcherManager,
      origin,
      disposers,
      callLog,
      outbox,
    );
  } catch (err) {
    await Promise.allSettled(disposers.map((dispose) => dispose()));
    throw err;
  }
}

async function assembleGatewayBots(
  config: EthosConfig,
  scheduler: CronScheduler,
  watcherManager: WatcherManager,
  origin: GatewayTurnOrigin,
  disposers: Array<() => Promise<void>>,
  callLog?: CallLog,
  outbox?: OutboxWiring,
): Promise<BuildGatewayBotsResult> {
  // Every personality loop gets the same scheduler + watcher manager so
  // agent-callable cron/watcher tools land in the shared stores. The thread
  // and sender resolvers ride along so background jobs record their full
  // origin lane and who started them, and the call log so a phone call one of these bots PLACES is recorded beside
  // the inbound ones rather than vanishing.
  const loopOpts = {
    cronScheduler: scheduler,
    watcherManager,
    ...origin,
    ...(callLog ? { callLog } : {}),
    // Every bot's loop gets the same outbox, so which bot a gated personality
    // was speaking as makes no difference to whether its publication is queued.
    ...(outbox ? { outbox } : {}),
  };
  const out: GatewayBotConfig[] = [];
  const setters: Array<(fn: MessagingSendFn) => void> = [];
  const routers: NotificationRouter[] = [];
  const registries: ToolRegistry[] = [];
  const refreshers: Array<() => Promise<void>> = [];
  // Per-bot attribution, derived rather than collected: every construction
  // below already pushes into the four flat lists, so the entries ONE bot
  // contributed are exactly what those lists grew by while it was being built.
  // Taking a mark and slicing keeps the flat lists byte-identical to what every
  // existing caller already receives — there is no second bookkeeping path to
  // drift from the first.
  const perBot = new Map<string, GatewayBotWiring>();
  const mark = (): [number, number, number, number, number] => [
    setters.length,
    routers.length,
    registries.length,
    refreshers.length,
    disposers.length,
  ];
  const record = (bot: GatewayBotConfig, at: [number, number, number, number, number]): void => {
    out.push(bot);
    perBot.set(bot.botKey, {
      messagingSetters: setters.slice(at[0]),
      notificationRouters: routers.slice(at[1]),
      toolRegistries: registries.slice(at[2]),
      refreshers: refreshers.slice(at[3]),
      disposers: disposers.slice(at[4]),
    });
  };
  const buildOne = async (bot: TelegramBotConfig | SlackAppConfig): Promise<GatewayBotConfig> => {
    const botKey = deriveBotKey(bot);
    let loop: AgentLoop;
    let jobStore: GatewayBotConfig['jobStore'];
    let backgroundExecutor: GatewayBotConfig['backgroundExecutor'];
    let jobControl: GatewayBotConfig['jobControl'];
    let mcpLogin: GatewayBotConfig['mcpLogin'];
    if (bot.bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bot.bind.name, {
        ...(outbox ? { outbox } : {}),
      });
      loop = team.loop;
      routers.push(team.notificationRouter);
      registries.push(team.toolRegistry);
      disposers.push(team.dispose);
    } else {
      // Per-bot personality loop. Threads the shared scheduler so
      // `create_cron_job` etc. lands in the same store as the
      // system-loop's jobs.
      const result = await createAgentLoop(
        { ...config, personality: bot.bind.name },
        { ...loopOpts, originBotKey: botKey },
      );
      loop = result.loop;
      jobStore = result.jobStore;
      backgroundExecutor = result.backgroundExecutor;
      jobControl = result.jobControl;
      setters.push(result.setMessagingSend);
      routers.push(result.notificationRouter);
      registries.push(result.toolRegistry);
      refreshers.push(result.refreshPersonalities);
      disposers.push(result.dispose);
      mcpLogin = await attachMcpLogin(result, disposers);
    }
    return {
      botKey,
      loop,
      binding: { ...bot.bind },
      ...(mcpLogin ? { mcpLogin } : {}),
      piiRedaction: bot.piiRedaction,
      ...(jobStore ? { jobStore } : {}),
      ...(backgroundExecutor ? { backgroundExecutor } : {}),
      ...(jobControl ? { jobControl } : {}),
      // D5 — `<bot entry>.budget`, enforced by `Gateway.enqueueTurn` and `backgroundGate`.
      budget: bot.budget,
      // Plan personality-presence-and-initiative §3 — applied by the gateway.
      ...(bot.replyPrefix ? { replyPrefix: bot.replyPrefix } : {}),
    };
  };
  for (const bot of config.telegram?.bots ?? []) {
    const at = mark();
    record(await buildOne(bot), at);
  }
  for (const app of config.slack?.apps ?? []) {
    const at = mark();
    record(await buildOne(app), at);
  }
  for (const waCfg of config.whatsapp ?? []) {
    const at = mark();
    const botKey = whatsAppBotKey(waCfg);
    // WhatsApp bind is optional (unlike telegram/slack). A bind-less entry
    // falls back to the default personality — but make that visible so a
    // misconfigured bot doesn't silently answer as the wrong persona.
    const bind = waCfg.bind ?? { type: 'personality' as const, name: config.personality };
    if (!waCfg.bind) {
      console.warn(
        `[whatsapp] bot "${botKey}" has no personality bind — using the default personality "${config.personality}". Re-save it in the app to bind a personality.`,
      );
    }
    let loop: AgentLoop;
    let jobStore: GatewayBotConfig['jobStore'];
    let backgroundExecutor: GatewayBotConfig['backgroundExecutor'];
    let jobControl: GatewayBotConfig['jobControl'];
    let mcpLogin: GatewayBotConfig['mcpLogin'];
    if (bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bind.name, {
        ...(outbox ? { outbox } : {}),
      });
      loop = team.loop;
      routers.push(team.notificationRouter);
      registries.push(team.toolRegistry);
      disposers.push(team.dispose);
    } else {
      const result = await createAgentLoop(
        { ...config, personality: bind.name },
        { ...loopOpts, originBotKey: botKey },
      );
      loop = result.loop;
      jobStore = result.jobStore;
      backgroundExecutor = result.backgroundExecutor;
      jobControl = result.jobControl;
      setters.push(result.setMessagingSend);
      routers.push(result.notificationRouter);
      registries.push(result.toolRegistry);
      refreshers.push(result.refreshPersonalities);
      disposers.push(result.dispose);
      mcpLogin = await attachMcpLogin(result, disposers);
    }
    record(
      {
        botKey,
        loop,
        binding: { ...bind },
        ...(mcpLogin ? { mcpLogin } : {}),
        piiRedaction: waCfg.piiRedaction,
        ...(jobStore ? { jobStore } : {}),
        ...(backgroundExecutor ? { backgroundExecutor } : {}),
        ...(jobControl ? { jobControl } : {}),
        budget: waCfg.budget,
      },
      at,
    );
  }
  // Inbound webhooks — each hookId becomes a first-class personality-bound bot
  // so POST /webhook/<hookId> drives the same gateway/session machinery as a
  // channel bot. botKey matches what the webhook server stamps on inbounds.
  for (const [hookId, hook] of Object.entries(config.webhooks ?? {})) {
    const at = mark();
    const botKey = `webhook:${hookId}`;
    const result = await createAgentLoop(
      { ...config, personality: hook.personalityId },
      { ...loopOpts, originBotKey: botKey },
    );
    setters.push(result.setMessagingSend);
    routers.push(result.notificationRouter);
    registries.push(result.toolRegistry);
    refreshers.push(result.refreshPersonalities);
    disposers.push(result.dispose);
    record(
      {
        botKey,
        loop: result.loop,
        binding: { type: 'personality', name: hook.personalityId },
        ...(result.jobStore ? { jobStore: result.jobStore } : {}),
        ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
        ...(result.jobControl ? { jobControl: result.jobControl } : {}),
      },
      at,
    );
  }
  // Legacy scalar Discord — register as a first-class bot bound to the default
  // personality so its inbound (stamped with the wiring-computed botKey)
  // resolves to a loop instead of dropping at the unknown-botKey gate. The
  // botKey MUST match what `buildAdapters` passes the DiscordAdapter.
  if (config.discordToken) {
    const at = mark();
    const botKey = discordBotKey(config.discordToken);
    const result = await createAgentLoop(config, { ...loopOpts, originBotKey: botKey });
    setters.push(result.setMessagingSend);
    routers.push(result.notificationRouter);
    registries.push(result.toolRegistry);
    refreshers.push(result.refreshPersonalities);
    disposers.push(result.dispose);
    record(
      {
        botKey,
        loop: result.loop,
        binding: { type: 'personality', name: config.personality },
        mcpLogin: await attachMcpLogin(result, disposers),
        ...(result.jobStore ? { jobStore: result.jobStore } : {}),
        ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
        ...(result.jobControl ? { jobControl: result.jobControl } : {}),
        ...(config.discord?.replyPrefix ? { replyPrefix: config.discord.replyPrefix } : {}),
      },
      at,
    );
  }
  // Legacy scalar Email — same treatment as Discord.
  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    const at = mark();
    const botKey = emailBotKey(config.emailUser, config.emailImapHost);
    const result = await createAgentLoop(config, { ...loopOpts, originBotKey: botKey });
    setters.push(result.setMessagingSend);
    routers.push(result.notificationRouter);
    registries.push(result.toolRegistry);
    refreshers.push(result.refreshPersonalities);
    disposers.push(result.dispose);
    record(
      {
        botKey,
        loop: result.loop,
        binding: { type: 'personality', name: config.personality },
        mcpLogin: await attachMcpLogin(result, disposers),
        ...(result.jobStore ? { jobStore: result.jobStore } : {}),
        ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
        ...(result.jobControl ? { jobControl: result.jobControl } : {}),
      },
      at,
    );
  }
  return {
    bots: out,
    messagingSetters: setters,
    notificationRouters: routers,
    toolRegistries: registries,
    refreshers,
    disposers,
    perBot,
  };
}

/**
 * A2A Stage 1d — register the outbound `a2a_send` tool on every gateway loop's
 * tool registry so an A2A call can originate from a channel turn (Telegram,
 * Slack, …), not just from `ethos serve`. Mirrors serve.ts's construction:
 * the SAME per-personality allowlist that gates inbound peers gates outbound
 * calls (egress default-deny, plan §15), and the tool is still gated by each
 * personality's `a2a` toolset.
 *
 * Unlike serve (which owns a live toggle), the gateway is a separate process
 * with no live settings flag: `isEnabled` reads the persisted `config.a2a`
 * value (plus the `ETHOS_A2A_ENABLED` override, for parity with serve). A
 * toggle therefore reaches the gateway on its next start — the documented
 * gateway behaviour (plan §13).
 *
 * Fail-open: constructing the A2A deps must NEVER crash gateway startup —
 * channels are the gateway's core job — so any failure is logged and swallowed.
 */
async function registerA2aOutboundTools(
  config: EthosConfig,
  registries: ToolRegistry[],
): Promise<void> {
  if (registries.length === 0) return;
  try {
    const isEnabled = () => config.a2a?.enabled === true || process.env.ETHOS_A2A_ENABLED === '1';
    const secrets = await getSecretsResolver();
    const storage = getStorage();
    const dir = ethosDir();
    const baseDir = join(dir, 'a2a');
    const personalities = await createPersonalityRegistry({
      storage,
      userPersonalitiesDir: join(dir, 'personalities'),
    });
    await personalities.loadFromDirectory(join(dir, 'personalities'));
    const identity = new PersonalityA2aIdentityProvider({
      personalities,
      secrets,
      storage,
      ...(config.webBaseUrl ? { baseUrl: config.webBaseUrl } : {}),
    });
    const allowlist = new StorageA2aAllowlist(storage, baseDir);
    const allowSelfLoop = process.env.ETHOS_A2A_SELF_LOOP === '1';
    const tools = createA2aTools({
      identity,
      secrets,
      allowlist,
      ...(allowSelfLoop ? { allowSelfLoop: true } : {}),
      isEnabled,
    });
    for (const registry of registries) {
      for (const tool of tools) registry.register(tool);
    }
    console.log(
      `${c.dim}a2a:          outbound tool registered on ${registries.length} loop(s) (${isEnabled() ? 'enabled' : 'disabled'})${c.reset}`,
    );
  } catch (err) {
    console.warn(
      `${c.yellow}⚠ a2a: outbound tool registration failed — A2A calls from channels unavailable${c.reset} ${c.dim}(${err instanceof Error ? err.message : String(err)})${c.reset}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Interactive tool-approval flow (Slack, Telegram, any ApprovalCapableAdapter)
// ---------------------------------------------------------------------------

/**
 * The idle watcher's busy predicate for the `ethos gateway` profile
 * (plan/phases/idle-watcher.md §1). Each source is a thin closure built HERE,
 * at the wiring site, so `@ethosagent/idle-watcher` needs no cross-extension
 * imports — the command layer already imports every subsystem (plan §5).
 *
 * ABSENT vs UNREADABLE (plan §2) is the whole point of the conditionals below.
 * A subsystem this deployment never constructed is SKIPPED — no source at all.
 * Registering one whose closure would throw on an undefined handle would make
 * the fail-awake wrapper report busy forever, i.e. every deployment
 * permanently busy, the exact opposite of useful. Only a
 * configured-but-unreadable check counts as busy.
 *
 * Exported so tests can assert the registered set without booting a gateway.
 */
export function buildGatewayBusySources(deps: {
  gateway: { hasActiveTurns(): boolean };
  dreamExecutor: { hasActiveDreams(): boolean };
  /** Background subsystems are per-bot; a bot without one contributes nothing. */
  bots: readonly {
    jobStore?: { countActive(): Promise<number> };
    backgroundExecutor?: { activeCount(): number };
  }[];
  approvalFlow: { pendingCount(): number };
  /** Opt-in: `undefined` when no webhook is configured. */
  webhookServer: { inFlightSyncRequests(): number } | undefined;
  /** `undefined` when this deployment constructs no scheduler. */
  cronScheduler: { hasRunningJobs(): Promise<boolean> } | undefined;
  /** Present only when this deployment constructs a `CallCaptureDaemon`
   *  (darwin + `callCapture.personalityId` set). Returns true whenever the
   *  daemon's last known state is anywhere but idle. */
  callCaptureActive: (() => boolean) | undefined;
  /** Flat `~/.ethos/teams` — see `pidFilePath` in @ethosagent/team-supervisor. */
  teamsPidDir: string;
  /**
   * Approved-but-unsent publications (O-D9). `undefined` when this deployment
   * wires no approval outbox — ABSENT, not zero, per the note above.
   */
  outboxPending?: () => number;
}): BusySource[] {
  const sources: BusySource[] = [
    {
      // Covers checks #1 AND #2: `hasActiveTurns()` ORs `activeTurns` and
      // `activeSinks`, which are cleared together in the same `finally`.
      name: 'gateway-turns',
      checkBusy: () =>
        Promise.resolve({
          busy: deps.gateway.hasActiveTurns(),
          reason: 'a channel turn or steer sink is in flight',
        }),
    },
    {
      name: 'dream-executor',
      checkBusy: () =>
        Promise.resolve({
          busy: deps.dreamExecutor.hasActiveDreams(),
          reason: 'a dream turn is running',
        }),
    },
    {
      // Always registered: `wireApprovalFlow` hands back a truthful `() => 0`
      // when no approval-capable adapter exists, so there is no undefined
      // handle to guard against.
      name: 'approvals',
      checkBusy: () => {
        const pending = deps.approvalFlow.pendingCount();
        return Promise.resolve({
          busy: pending > 0,
          reason: `${pending} tool approval(s) awaiting a human decision`,
        });
      },
    },
    {
      // Detached children (`detached: true` + `unref()`), so the PID file is
      // the only signal there is. `hasLiveTeamProcesses` is itself fail-awake:
      // a missing directory means no teams, anything else unreadable is busy.
      name: 'team-supervisors',
      checkBusy: () =>
        Promise.resolve({
          busy: hasLiveTeamProcesses(deps.teamsPidDir),
          reason: 'a detached team supervisor is alive',
        }),
    },
  ];

  const executors = deps.bots
    .map((bot) => bot.backgroundExecutor)
    .filter((executor) => executor !== undefined);
  if (executors.length > 0) {
    sources.push({
      name: 'background-jobs',
      checkBusy: () => {
        const active = executors.reduce((total, executor) => total + executor.activeCount(), 0);
        return Promise.resolve({ busy: active > 0, reason: `${active} background job(s) running` });
      },
    });
  }

  const jobStores = deps.bots.map((bot) => bot.jobStore).filter((store) => store !== undefined);
  if (jobStores.length > 0) {
    sources.push({
      // Durable, unscoped: queued/running/blocked rows survive a restart, so a
      // suspend here would strand work no in-process counter can see.
      name: 'job-store',
      checkBusy: async () => {
        const counts = await Promise.all(jobStores.map((store) => store.countActive()));
        return {
          busy: counts.some((n) => n > 0),
          reason: 'the durable job store has queued/running/blocked jobs',
        };
      },
    });
  }

  const cronScheduler = deps.cronScheduler;
  if (cronScheduler) {
    sources.push({
      // Persisted `runningSince` stamps (plan §1 check #7), so this sees runs
      // started by a peer process sharing the cron dir too, not just this one.
      name: 'cron-executions',
      checkBusy: async () => ({
        busy: await cronScheduler.hasRunningJobs(),
        reason: 'a cron job is mid-execution',
      }),
    });
  }

  const callCaptureActive = deps.callCaptureActive;
  if (callCaptureActive) {
    sources.push({
      name: 'call-capture',
      checkBusy: () =>
        Promise.resolve({
          busy: callCaptureActive(),
          reason: 'a call-capture session is active',
        }),
    });
  }

  const outboxPending = deps.outboxPending;
  if (outboxPending) {
    sources.push({
      // Durable, and owed to a person: a human approved this text and it has
      // not gone out yet. Suspending here is how an approval for a
      // time-sensitive post quietly reaches its 24h validity window unused.
      // `awaiting_approval` items are deliberately NOT counted — a human may
      // take days, and a machine that cannot suspend while someone thinks is a
      // machine that never suspends.
      name: 'outbox-publications',
      checkBusy: () => {
        const pending = outboxPending();
        return Promise.resolve({
          busy: pending > 0,
          reason: `${pending} approved publication(s) not yet delivered`,
        });
      },
    });
  }

  const webhookServer = deps.webhookServer;
  if (webhookServer) {
    sources.push({
      name: 'webhook-in-flight',
      checkBusy: () => {
        const inFlight = webhookServer.inFlightSyncRequests();
        return Promise.resolve({
          busy: inFlight > 0,
          reason: `${inFlight} webhook request(s) parked on the synchronous reply path`,
        });
      },
    });
  }

  return sources;
}

/**
 * Validate that every bot binding points at a real personality or team
 * on disk. Personality set comes from the same `FilePersonalityRegistry`
 * the agent loop uses at runtime — no duplicated roster of built-ins
 * to drift the next time built-ins change. Team set comes from
 * `~/.ethos/teams/<name>.yaml`.
 */
export async function validateBindings(config: EthosConfig): Promise<string[]> {
  const storage = getStorage();
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: join(ethosDir(), 'personalities'),
  });
  // `loadFromDirectory` uses Storage.list, which returns [] for a
  // missing directory — so we don't pre-check existence. Genuine
  // load errors (corrupt personality file, parse failure, permission
  // denied) propagate here at validation time rather than crashing
  // the first inbound message later.
  await registry.loadFromDirectory(join(ethosDir(), 'personalities'));
  const personalityIds = new Set<string>(registry.list().map((p) => p.id));

  // Team manifests live at ~/.ethos/teams/<name>.yaml. Storage.listEntries
  // is the constitution-approved listing primitive and yields an empty
  // list for a missing directory, so no pre-check needed.
  const teamNames = new Set<string>();
  for (const entry of await storage.listEntries(join(ethosDir(), 'teams'))) {
    if (entry.name.endsWith('.yaml')) teamNames.add(entry.name.replace(/\.yaml$/, ''));
  }
  return validateBotBindings(config, { personalityIds, teamNames });
}

/**
 * Build the `/ethos personality rich` card reader: the personality registry
 * supplies config + SOUL.md, and the shared `SkillsInjector.resolveSkills()`
 * supplies the resolved skill set. The injector is constructed the way
 * `createInjectors` builds it for the agent loop, so the card never drifts
 * from what the personality actually sees. Built once at boot; `read()`
 * reloads the registry (mtime-cached, cheap) so an edited personality
 * reflects without a gateway restart.
 */
async function createSlackPersonalityCardReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  const { skillsInjector } = createInjectors(registry, {
    storage,
    trustedFirstPartySources: [bundledSkillsSource()],
  });
  return {
    async read(personalityId: string) {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) return null;
      const soulMd = await registry.readSoulMd(personalityId);
      const resolved = await skillsInjector.resolveSkills(personalityId);
      return {
        id: config.id,
        name: config.name,
        description: config.description ?? '',
        prose: firstParagraph(soulMd),
        model: resolveModelDisplay(config.model),
        provider: config.provider ?? '(engine default)',
        toolset: config.toolset ?? [],
        skills: resolved.map((r) => ({ id: r.id, source: r.source })),
      };
    },
  };
}

/** Close what `createSlackSessionReaders` and `openBranchSessionStore` opened.
 *  A no-op when neither ever ran. Called by `ethos gateway`'s and `ethos boot`'s
 *  shutdown. */
export function closeSlackSessionStores(): void {
  for (const store of slackSessionStores) store.close();
  slackSessionStores.clear();
  branchSessionStore = undefined;
  spendSessionStore = undefined;
  spendLedger = undefined;
}

let branchSessionStore: SessionStore | undefined;

/**
 * The `sessions.db` handle the gateway's `/fork`, `/branches` and `/branch <n>`
 * use (`GatewayConfig.sessionStore`). Opened once, on the first branch command,
 * and registered in `slackSessionStores` so the same shutdown closes it.
 */
function openBranchSessionStore(): SessionStore {
  if (!branchSessionStore) {
    const opened = createSessionStore({ dataDir: ethosDir() });
    slackSessionStores.add(opened);
    branchSessionStore = opened;
  }
  return branchSessionStore;
}

let spendSessionStore: SQLiteSessionStore | undefined;
let spendLedger: SQLiteUsageLedger | undefined;

/**
 * `GatewayConfig.botSpendSince` for a production host (plan
 * openclaw-2026.9.6-gaps D5, background-usage-accounting D40): one bot's USD
 * spend since `since`, split into {@link BotSpend}.
 *
 * - `repliesUsd` — message rows under the bot's session-key prefix, from
 *   `SQLiteSessionStore.usageAggregate` by `source` with only the message keys
 *   (`turn`, `turn:<prefix>`; ledger keys are `<source_class>:<kind>`) summed,
 *   plus the ledger's `turn_utility` rows.
 * - `backgroundUsd` — the ledger's `background` rows. Ledger rows match the
 *   bot's key OR its session-key prefix, each once (`SQLiteUsageLedger.spendSince`):
 *   a memory-capture job carries the build's `botKey` and no session key.
 *
 * Message rows and ledger rows are disjoint (§5.5), so the parts add. The
 * concrete stores rather than `createSessionStore`'s `SessionStore`, because
 * neither read is on the interface. Opened on the first capped read and closed
 * by `closeSlackSessionStores()` with the others. Pinned by
 * `__tests__/gateway-daily-budget-wiring.test.ts`.
 */
export async function botSpendSince(
  scope: { sessionKeyPrefix: string; botKey: string },
  since: Date,
  open: () => SQLiteSessionStore = () => {
    if (!spendSessionStore) {
      const opened = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
      slackSessionStores.add(opened);
      spendSessionStore = opened;
    }
    return spendSessionStore;
  },
  openLedger: () => SQLiteUsageLedger = () => {
    if (!spendLedger) {
      const opened = new SQLiteUsageLedger(join(ethosDir(), 'sessions.db'));
      slackSessionStores.add(opened);
      spendLedger = opened;
    }
    return spendLedger;
  },
): Promise<BotSpend> {
  const rows = await open().usageAggregate({
    since,
    // Open-ended: a row stamped in this very millisecond counts too. A 4-digit
    // year, because the query compares ISO strings.
    until: new Date('9999-12-31T23:59:59.999Z'),
    dimension: 'source',
    keyPrefix: scope.sessionKeyPrefix,
  });
  const turnUsd = rows
    .filter((r) => r.key === 'turn' || r.key.startsWith('turn:'))
    .reduce((sum, r) => sum + r.estimatedCostUsd, 0);
  const ledger = openLedger().spendSince({
    since,
    botKey: scope.botKey,
    keyPrefix: scope.sessionKeyPrefix,
  });
  return { repliesUsd: turnUsd + ledger.turnUtilityUsd, backgroundUsd: ledger.backgroundUsd };
}

/**
 * Build the `/personalities/<id>` unfurl reader. Same registry the
 * `/ethos personality rich` card reader uses, reloaded per lookup (mtime-cached,
 * so an edited personality unfurls without a gateway restart).
 */
async function createSlackPersonalityUnfurlReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  return {
    async lookupPersonality(id: string) {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(id);
      if (!config) return null;
      return { id: config.id, name: config.name, description: config.description ?? '' };
    },
  };
}

/**
 * Build the `/ethos kanban list` reader and the `/kanban/<ticket>` unfurl
 * reader for a team-bound Slack bot. Both open the team's `board.db` per call
 * and close it — the board is small, the reads are rare (a slash command or a
 * pasted link), and a long-lived handle in the adapter would outlive the
 * board's own lifecycle. A team with no board yet degrades to an empty list /
 * skipped unfurl rather than creating one.
 */
function createSlackKanbanReaders(teamName: string) {
  const boardPath = resolveKanbanDbPath({ teamName }, ethosDir());
  const open = async (): Promise<KanbanStore | null> => {
    if (!(await getStorage().exists(boardPath))) return null;
    return new KanbanStore(boardPath, { teamId: teamName });
  };
  return {
    kanban: {
      async listOpenTickets() {
        const store = await open();
        if (!store) return [];
        try {
          return store
            .listTasks({ limit: 200 })
            .filter((t) => t.status !== 'done' && t.status !== 'archived')
            .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee }));
        } finally {
          store.close();
        }
      },
    },
    kanbanUnfurl: {
      async lookupTicket(id: string) {
        const store = await open();
        if (!store) return null;
        try {
          const task = store.getTask(id);
          if (!task) return null;
          return {
            id: task.id,
            title: task.title,
            status: task.status,
            assignee: task.assignee,
            parentGoal: store.getParents(task.id)[0]?.title ?? null,
          };
        } finally {
          store.close();
        }
      },
    },
  };
}

/**
 * Build the Telegram `/personality rich` card reader. Mirrors the Slack
 * reader but renders the card as Telegram Markdown text via the Telegram
 * personality module. Lazily imports `@ethosagent/platform-telegram` so
 * the function stays safe when the Telegram adapter SDK isn't installed.
 */
export async function createTelegramPersonalityCardReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  const { skillsInjector } = createInjectors(registry, {
    storage,
    trustedFirstPartySources: [bundledSkillsSource()],
  });
  // Lazily import the Telegram personality renderer. The import type is
  // erased at runtime; the `as` cast is safe because we catch import failure.
  let renderFn: ((card: Record<string, unknown>) => string) | null = null;
  try {
    const mod = await import('@ethosagent/platform-telegram/personality');
    renderFn = mod.personalityRichMessage as unknown as (card: Record<string, unknown>) => string;
  } catch {
    // Telegram personality module not available — reader will return null.
  }
  return {
    async read(personalityId: string): Promise<{ text: string } | null> {
      if (!renderFn) return null;
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) return null;
      const soulMd = await registry.readSoulMd(personalityId);
      const resolved = await skillsInjector.resolveSkills(personalityId);
      const card = {
        id: config.id,
        name: config.name,
        description: config.description ?? '',
        prose: firstParagraph(soulMd),
        model: resolveModelDisplay(config.model),
        provider: config.provider ?? '(engine default)',
        toolset: config.toolset ?? [],
        skills: resolved.map((r) => ({ id: r.id, source: r.source })),
      };
      return { text: renderFn(card) };
    },
  };
}

/**
 * Build the Telegram `/start` greeting provider. Returns a personality-aware
 * greeting composed of the personality's description (or first paragraph of
 * SOUL.md), plus a pointer to `/help`.
 */
export async function createTelegramGreetingProvider() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  return {
    async greet(personalityId: string): Promise<string> {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) {
        return `Hello! I'm *${personalityId}*. Send a message to get started, or try /help for available commands.`;
      }
      const soulMd = await registry.readSoulMd(personalityId).catch(() => '');
      const prose = firstParagraph(soulMd);
      const intro = prose || config.description || config.name;
      return `${intro}\n\nUse /help to see available commands.`;
    },
  };
}

/**
 * Construct one PlatformAdapter per configured bot/app, in addition to
 * single legacy adapters for discord + email. Exported so tests can
 * exercise the multi-bot adapter loop with a mocked module loader
 * (avoiding a real grammy / @slack/bolt construction in unit tests).
 *
 * Applies `applyPlatformShim` defensively so callers that pass a
 * legacy single-bot config (`telegramToken` / `slackBotToken` etc.)
 * still construct adapters correctly. The shim is idempotent — when
 * the boot path already normalized via `loadConfigStrict`, the
 * second pass is a no-op.
 */
export async function buildAdapters(
  config: EthosConfig,
  loadAdapter: AdapterModuleLoader,
  attachmentCache?: import('@ethosagent/types').AttachmentCache,
  opts?: {
    onWhatsAppQr?: (botId: string, qr: string | null) => void;
    onWhatsAppPairingCode?: (botId: string, code: string | null) => void;
  },
): Promise<PlatformAdapter[]> {
  config = applyPlatformShim(config).config;
  const adapters: PlatformAdapter[] = [];
  // Adapter diagnostics. Telegram, Slack and WhatsApp take an optional
  // `logger` and go silent without one — Slack's "authenticated as @…" line
  // and Telegram's observe-mode privacy-mode warning are only reachable
  // because this is passed. Each adapter `child()`s it with its own tag.
  const adapterLogger = new ConsoleLogger({}, config.logs?.level);

  if ((config.telegram?.bots.length ?? 0) > 0) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-telegram')>(
      '@ethosagent/platform-telegram',
      'Telegram',
    );
    if (mod) {
      // Resolve identity for personality-bound bots from the registry.
      const storage = getStorage();
      const personalitiesDir = join(ethosDir(), 'personalities');
      const registry = await createPersonalityRegistry({
        storage,
        userPersonalitiesDir: personalitiesDir,
      });
      await registry.loadFromDirectory(personalitiesDir);

      // Telegram adapter requires a cache. When the caller provides one
      // (production gateway path), use it; otherwise create one on the fly
      // (test / standalone path).
      let telegramCache = attachmentCache;
      if (!telegramCache) {
        const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
        telegramCache = new FsAttachmentCache(storage, join(ethosDir(), 'cache', 'attachments'));
      }

      for (const botCfg of config.telegram?.bots ?? []) {
        let identity: { name: string; shortDescription: string; description: string } | undefined;
        if (botCfg.bind.type === 'personality') {
          const pConfig = registry.get(botCfg.bind.name);
          if (pConfig) {
            const soulMd = await registry.readSoulMd(botCfg.bind.name).catch(() => '');
            const prose = firstParagraph(soulMd);
            identity = {
              name: pConfig.name,
              shortDescription: pConfig.description ?? pConfig.name,
              description: prose || pConfig.description || pConfig.name,
            };
          }
        }
        adapters.push(
          new mod.TelegramAdapter({
            token: botCfg.token,
            cache: telegramCache,
            botKey: deriveBotKey(botCfg),
            // Straight through, no `??` default: the adapter already defaults
            // this to `false` (`dropPendingUpdates ?? false`, owner decision
            // D3 — a restart keeps the queued backlog), so defaulting it here
            // as well would mean two places to change and a config value
            // silently overridden if they ever drift.
            dropPendingUpdates: botCfg.dropPendingUpdates,
            // Webhook mode (plan/phases/telegram-slack-webhook-mode.md §2a).
            // Absent from config = long-poll, exactly today's behaviour. The
            // adapter throws from `start()` if `useWebhook` arrives without a
            // URL or secret token, so no validation is duplicated here.
            ...(botCfg.useWebhook !== undefined ? { useWebhook: botCfg.useWebhook } : {}),
            ...(botCfg.webhookUrl ? { webhookUrl: botCfg.webhookUrl } : {}),
            ...(botCfg.webhookSecretToken ? { webhookSecretToken: botCfg.webhookSecretToken } : {}),
            ...(identity ? { identity } : {}),
            // Plan personality-presence-and-initiative §3: a group message
            // naming the bound personality counts as a mention. The name comes
            // from the gateway's presence resolver (`Gateway.bindPresence`).
            ...(botCfg.mentionByName !== undefined ? { mentionByName: botCfg.mentionByName } : {}),
            // Backs the `channelModes: true` the adapter advertises: without a
            // Storage there is no per-chat override store, so `/ethos
            // channel-mode` has nowhere to write and every chat is stuck on
            // the default below. The adapter appends the botKey itself, but
            // its own fallback is the RELATIVE `'telegram'` — under FsStorage,
            // which takes absolute paths, that resolves against the process
            // CWD. Same shape the WhatsApp site passes.
            storage,
            telegramDir: join(ethosDir(), 'telegram'),
            ...(botCfg.defaultChannelMode ? { defaultChannelMode: botCfg.defaultChannelMode } : {}),
            // Reaches `warnIfPrivacyModeHidesObserved`, which is the only
            // thing that tells an operator their observe-mode bot is watching
            // rooms BotFather's privacy setting stops it from hearing.
            logger: adapterLogger,
            // Operator override for the inbound-attachment ceiling. Absent
            // leaves each adapter on its own platform default — the platforms
            // themselves disagree about what is deliverable.
            ...(config.gateway?.maxInboundMediaBytes !== undefined
              ? { maxInboundMediaBytes: config.gateway.maxInboundMediaBytes }
              : {}),
          }),
        );
      }
    }
  }

  if ((config.slack?.apps.length ?? 0) > 0) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-slack')>(
      '@ethosagent/platform-slack',
      'Slack',
    );
    if (mod) {
      // Slack adapters consume `binding` (member-join greeting, /ethos
      // personality, /ethos help) and `storage` (per-channel mode
      // overrides + thread-participation state). The adapter owns its
      // on-disk layout under <storage_root>/slack — wiring stays out of
      // that decision so the filesystem path doesn't show up in two
      // places.
      const slackStorage = getStorage();
      // One card reader serves every Slack bot — `read()` takes the
      // personality id, so it isn't bot-specific. The handler only consults
      // it for personality bindings (`/ethos personality rich`).
      const personalityCard = await createSlackPersonalityCardReader();
      // Likewise bot-agnostic: `lookupPersonality` takes the id from the
      // shared URL.
      const personalityUnfurl = await createSlackPersonalityUnfurlReader();
      // The Ethos web UI origin is not a Slack-specific setting — it's the
      // same public URL the OAuth redirect and the web app use
      // (`ETHOS_PUBLIC_URL` env > `webBaseUrl` in config.yaml). Passing it is
      // what turns App Home deep links on AND registers the `link_shared`
      // unfurl handler at all; without it `registerLinkEvents` returns early.
      const webUiBaseUrl = config.webBaseUrl;
      for (const appCfg of config.slack?.apps ?? []) {
        // `/ethos memory show|add` reads the bound personality's MEMORY.md.
        // Team bindings have no single MEMORY.md, so they keep degrading to
        // "Memory is unavailable for this bot."
        const memory =
          appCfg.bind.type === 'personality'
            ? createSlackMemoryReader(appCfg.bind.name, config)
            : undefined;
        const botKey = deriveBotKey(appCfg);
        // Session rows are per-bot: the reader filters on this bot's lane-key
        // prefix.
        const { session, sessionUnfurl } = createSlackSessionReaders(botKey);
        // Kanban is a team feature — a personality-bound bot has no board, and
        // the slash command already says so. Leaving the readers unwired keeps
        // the App Home section and the ticket unfurl hidden for those bots.
        const kanbanReaders =
          appCfg.bind.type === 'team' ? createSlackKanbanReaders(appCfg.bind.name) : undefined;
        adapters.push(
          new mod.SlackAdapter({
            botToken: appCfg.botToken,
            appToken: appCfg.appToken,
            signingSecret: appCfg.signingSecret,
            botKey,
            binding: { type: appCfg.bind.type, name: appCfg.bind.name },
            // Always passed, never conditionally spread: an omitted key would
            // leave the gate's state implicit, and this gate denies by
            // default precisely so nothing depends on omission.
            allowedUsers: slackSlashAllowlist(
              config.channelFilter?.slack,
              appCfg.allowedSlashUsers,
            ),
            // CHS-005 — adapter-local refusals land in the same audit trail as
            // approvals. Resolved lazily so a boot that never refuses anything
            // does not open the observability DB.
            observability: {
              recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts),
            },
            storage: slackStorage,
            // `SlackAdapterConfig.logger` defaults to a NoopLogger, so until
            // this was passed the adapter's own startup diagnostics went
            // nowhere.
            logger: adapterLogger,
            personalityCard,
            personalityUnfurl,
            session,
            sessionUnfurl,
            ...(attachmentCache ? { cache: attachmentCache } : {}),
            ...(memory ? { memory } : {}),
            ...(kanbanReaders
              ? { kanban: kanbanReaders.kanban, kanbanUnfurl: kanbanReaders.kanbanUnfurl }
              : {}),
            ...(appCfg.defaultChannelMode ? { defaultChannelMode: appCfg.defaultChannelMode } : {}),
            ...(appCfg.receiptReaction ? { receiptReaction: appCfg.receiptReaction } : {}),
            ...(appCfg.mentionByName !== undefined ? { mentionByName: appCfg.mentionByName } : {}),
            ...(appCfg.allowedBotIds?.length ? { allowedBotIds: appCfg.allowedBotIds } : {}),
            ...(appCfg.longReplyThresholdChars !== undefined
              ? { longReplyThresholdChars: appCfg.longReplyThresholdChars }
              : {}),
            ...(webUiBaseUrl ? { webUiBaseUrl } : {}),
            // Inbound transport (plan/phases/telegram-slack-webhook-mode.md
            // §3b). Absent = Socket Mode, exactly today's behaviour. The
            // adapter enforces mutual exclusivity and the per-mode credential
            // requirements (`appToken` for socket, `signingSecret` for http).
            ...(appCfg.mode ? { mode: appCfg.mode } : {}),
            ...(appCfg.webhookPath ? { webhookPath: appCfg.webhookPath } : {}),
            ...(config.gateway?.maxInboundMediaBytes !== undefined
              ? { maxInboundMediaBytes: config.gateway.maxInboundMediaBytes }
              : {}),
          }),
        );
      }
    }
  }

  if (config.discordToken) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-discord')>(
      '@ethosagent/platform-discord',
      'Discord',
    );
    if (mod) {
      adapters.push(
        new mod.DiscordAdapter({
          token: config.discordToken,
          botKey: discordBotKey(config.discordToken),
          // CHS-005 — see the Slack adapter above; a refused approval click is
          // otherwise visible only to the person refused.
          observability: {
            recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts),
          },
          ...(config.gateway?.maxInboundMediaBytes !== undefined
            ? { maxInboundMediaBytes: config.gateway.maxInboundMediaBytes }
            : {}),
          // Backs the `channelModes: true` the adapter advertises, and the
          // `threadState` / `backfillState` stores it only builds when a
          // Storage arrives. The adapter's own directory fallback is the
          // RELATIVE `'discord'` — under FsStorage, which takes absolute
          // paths, that resolves against the process CWD. Same shape the
          // Telegram, Slack and WhatsApp sites pass.
          storage: getStorage(),
          discordDir: join(ethosDir(), 'discord'),
          ...(config.discord?.defaultChannelMode
            ? { defaultChannelMode: config.discord.defaultChannelMode }
            : {}),
          // Without roles the adapter's default `role_gate` refuses every
          // Approve/Deny click and each approval waits out its timeout.
          ...(config.discord?.approvalRoleIds
            ? { approvalRoleIds: config.discord.approvalRoleIds }
            : {}),
          ...(config.discord?.missedMessageBackfill
            ? { missedMessageBackfill: config.discord.missedMessageBackfill }
            : {}),
          ...(config.discord?.mentionByName !== undefined
            ? { mentionByName: config.discord.mentionByName }
            : {}),
          // UD4 — `discord.post_thinking_placeholder: false` turns the
          // "Thinking…" placeholder off. Included only when the operator set
          // it, so the adapter's own default (ON) stays the single owner.
          ...(config.discordPostThinkingPlaceholder !== undefined
            ? { postThinkingPlaceholder: config.discordPostThinkingPlaceholder }
            : {}),
        }),
      );
    }
  }

  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-email')>(
      '@ethosagent/platform-email',
      'Email',
    );
    if (mod) {
      adapters.push(
        new mod.EmailAdapter({
          imapHost: config.emailImapHost,
          imapPort: config.emailImapPort ?? 993,
          user: config.emailUser,
          password: config.emailPassword,
          smtpHost: config.emailSmtpHost,
          smtpPort: config.emailSmtpPort ?? 587,
          botKey: emailBotKey(config.emailUser, config.emailImapHost),
          // Persists each chat's reply-threading state so a reply the delivery
          // ledger redelivers after a restart still reaches the right thread.
          storage: getStorage(),
          emailDir: join(ethosDir(), 'email'),
          // Unset → every sender is unverified (`resolveEmailSender`); the
          // boot-time warning is `warnEmailSenderAuthUnconfigured`.
          ...(config.emailTrustedAuthservId
            ? { trustedAuthservId: config.emailTrustedAuthservId }
            : {}),
        }),
      );
    }
  }

  if ((config.whatsapp?.length ?? 0) > 0) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-whatsapp')>(
      '@ethosagent/platform-whatsapp',
      'WhatsApp',
    );
    if (mod) {
      let waCache = attachmentCache;
      if (!waCache) {
        const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
        waCache = new FsAttachmentCache(getStorage(), join(ethosDir(), 'cache', 'attachments'));
      }

      const waConfigs = config.whatsapp ?? [];
      if (waConfigs.length > 1) {
        const missingIds = waConfigs.filter((c) => !c.id);
        if (missingIds.length > 0) {
          throw new EthosError({
            code: 'CONFIG_INVALID',
            cause: `[whatsapp] Multiple WhatsApp configs require explicit 'id' fields. ${missingIds.length} config(s) are missing an id.`,
            action: "Add an 'id' field to each WhatsApp config in ~/.ethos/config.yaml.",
          });
        }
        const ids = waConfigs.map((c) => c.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length > 0) {
          throw new EthosError({
            code: 'CONFIG_INVALID',
            cause: `[whatsapp] Duplicate WhatsApp bot IDs: ${dupes.join(', ')}. Each config must have a unique id.`,
            action:
              "Ensure each WhatsApp config in ~/.ethos/config.yaml has a distinct 'id' value.",
          });
        }
      }

      for (const waCfg of config.whatsapp ?? []) {
        const onQrCb = opts?.onWhatsAppQr;
        const onPairingCb = opts?.onWhatsAppPairingCode;
        adapters.push(
          new mod.WhatsAppAdapter({
            id: waCfg.id,
            botKey: whatsAppBotKey(waCfg),
            sessionDir: waCfg.session_dir ?? join(ethosDir(), 'whatsapp'),
            defaultMode: waCfg.default_mode ?? 'mention_only',
            // Backs the `channelModes: true` the adapter advertises: without a
            // Storage there is no per-chat override store, and every chat is
            // stuck on `defaultMode`.
            storage: getStorage(),
            whatsappDir: join(ethosDir(), 'whatsapp'),
            allowedJids: waCfg.allowed_numbers,
            cache: waCache,
            onQr: onQrCb ? (qr) => onQrCb(waCfg.id ?? 'default', qr) : undefined,
            ...(waCfg.phone_number ? { phoneNumber: waCfg.phone_number } : {}),
            onPairingCode: onPairingCb
              ? (code) => onPairingCb(waCfg.id ?? 'default', code)
              : undefined,
            ...(config.gateway?.maxInboundMediaBytes !== undefined
              ? { maxInboundMediaBytes: config.gateway.maxInboundMediaBytes }
              : {}),
            // Pairing-code and QR failures, including the rate-limit stop.
            logger: adapterLogger,
          }),
        );
      }
    }
  }

  return adapters;
}

/**
 * Build one `TelegramClarifySurface` per (Telegram adapter, Telegram bot)
 * pair. Loaded lazily — when the platform-telegram surface module isn't
 * installed (or no Telegram adapter is configured), returns `[]` and the
 * Gateway runs without a clarify correlator. The surface registers
 * `bridge.registerPresenter`, `bridge.onResolved`, and `adapter.onCallbackQuery`
 * in its constructor; the gateway later calls `surface.correlateMessage` for
 * every inbound message.
 *
 * `getSessionRouting` resolves a sessionId to the chat + originator user id
 * of the turn that issued the clarify. Closes over a gateway reference that
 * is filled in *after* this function returns (the surface and the Gateway
 * each need a reference to the other), so callers must pass a closure rather
 * than a direct gateway method.
 */
async function buildTelegramClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; requesterUserId?: string } | undefined,
): Promise<{ correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null> }[]> {
  const telegramAdapters = adapters.filter((a) => a.id.startsWith('telegram:'));
  if (telegramAdapters.length === 0) return [];

  const mod = await loadAdapterModule<
    typeof import('@ethosagent/platform-telegram/clarify-surface')
  >('@ethosagent/platform-telegram/clarify-surface', 'Telegram clarify surface');
  if (!mod) return [];

  const surfaces: {
    correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null>;
  }[] = [];
  for (const adapter of telegramAdapters) {
    // `adapter.id` is `telegram:<botKey>` — strip the prefix to find the
    // matching bot's clarifyBridge.
    const botKey = adapter.id.slice('telegram:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    // The TelegramAdapter satisfies TelegramClarifyAdapter structurally —
    // the methods were added in the same package.
    const tgAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.TelegramClarifySurface
    >[0]['adapter'];
    surfaces.push(
      new mod.TelegramClarifySurface({
        adapter: tgAdapter,
        bridge,
        store: bridge.store,
        getSessionRouting,
      }),
    );
  }
  return surfaces;
}

/**
 * Build one `SlackClarifySurface` per (Slack adapter, Slack bot) pair.
 * Loaded lazily — when the platform-slack surface module isn't installed
 * (or no Slack adapter is configured), returns `[]` and Slack just runs
 * without clarify support. Each surface registers `bridge.registerPresenter`,
 * `bridge.onResolved`, `adapter.onClarifyAction`, and
 * `adapter.onClarifyModalSubmit` in its constructor; nothing else needs
 * wiring (Slack carries its own button-click + modal-submission events
 * through Bolt, so there's no inbound-correlator step like Telegram has
 * for force-replies).
 */
async function buildSlackClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; threadId?: string; requesterUserId?: string } | undefined,
): Promise<unknown[]> {
  const slackAdapters = adapters.filter((a) => a.id.startsWith('slack:'));
  if (slackAdapters.length === 0) return [];

  const mod = await loadAdapterModule<typeof import('@ethosagent/platform-slack/clarify-surface')>(
    '@ethosagent/platform-slack/clarify-surface',
    'Slack clarify surface',
  );
  if (!mod) return [];

  const surfaces: unknown[] = [];
  for (const adapter of slackAdapters) {
    const botKey = adapter.id.slice('slack:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    const slackAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.SlackClarifySurface
    >[0]['adapter'];
    const surface = new mod.SlackClarifySurface({
      adapter: slackAdapter,
      bridge,
      store: bridge.store,
      getSessionRouting,
      // CHS-005 — the cross-tenant gate drops a click silently by design; the
      // audit row is what makes a replay attempt investigable afterwards.
      observability: {
        recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts),
      },
    });
    // Wire the App Home "Waiting on you" data source. Setter must run
    // before adapter.start() so registerHomeEvents picks it up.
    const withReader = adapter as unknown as {
      setClarifyHomeReader?: (r: { listPendingForBot: () => Promise<unknown[]> }) => void;
    };
    withReader.setClarifyHomeReader?.(surface);
    surfaces.push(surface);
  }
  return surfaces;
}

/**
 * Build one `DiscordClarifySurface` per (Discord adapter, Discord bot) pair.
 * Currently Discord supports a single bot per process (the legacy single
 * `discordToken` config), so this typically builds 0 or 1 surface. Loaded
 * lazily — when the surface module isn't installed (or no Discord adapter
 * is configured), returns `[]`.
 */
async function buildDiscordClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  systemLoop: AgentLoop,
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; requesterUserId?: string } | undefined,
): Promise<unknown[]> {
  const discordAdapters = adapters.filter((a) => a.id.startsWith('discord:'));
  if (discordAdapters.length === 0) return [];

  const mod = await loadAdapterModule<
    typeof import('@ethosagent/platform-discord/clarify-surface')
  >('@ethosagent/platform-discord/clarify-surface', 'Discord clarify surface');
  if (!mod) return [];

  const surfaces: unknown[] = [];
  for (const adapter of discordAdapters) {
    const botKey = adapter.id.slice('discord:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    // Per-bot loop wins; legacy single-Discord (no entry in `bots[]`) falls
    // back to the system loop. Either way, the bridge must exist — the
    // wiring layer always attaches one, so an absent bridge is a bug.
    const bridge = bot?.loop.clarifyBridge ?? systemLoop.clarifyBridge;
    if (!bridge) continue;
    const discordAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.DiscordClarifySurface
    >[0]['adapter'];
    surfaces.push(
      new mod.DiscordClarifySurface({
        adapter: discordAdapter,
        bridge,
        store: bridge.store,
        getSessionRouting,
      }),
    );
  }
  return surfaces;
}

/**
 * Build one `WhatsAppClarifySurface` per (WhatsApp adapter, WhatsApp bot)
 * pair. Loaded lazily — when the surface module isn't installed (or no
 * WhatsApp adapter is configured), returns `[]` and WhatsApp runs without
 * clarify support.
 *
 * WhatsApp has no interactive-component transport (Baileys 7 can neither
 * send buttons/lists nor decode their responses), so the surface presents a
 * numbered prompt and, like Telegram, resolves it through the gateway's
 * `clarifyMessageCorrelator`.
 */
async function buildWhatsAppClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; requesterUserId?: string } | undefined,
): Promise<{ correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null> }[]> {
  const whatsAppAdapters = adapters.filter((a) => a.id.startsWith('whatsapp:'));
  if (whatsAppAdapters.length === 0) return [];

  const mod = await loadAdapterModule<
    typeof import('@ethosagent/platform-whatsapp/clarify-surface')
  >('@ethosagent/platform-whatsapp/clarify-surface', 'WhatsApp clarify surface');
  if (!mod) return [];

  const surfaces: {
    correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null>;
  }[] = [];
  for (const adapter of whatsAppAdapters) {
    // `adapter.id` is `whatsapp:<botKey>` — strip the prefix to find the
    // matching bot's clarifyBridge.
    const botKey = adapter.id.slice('whatsapp:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    // The WhatsAppAdapter satisfies WhatsAppClarifyAdapter structurally.
    const waAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.WhatsAppClarifySurface
    >[0]['adapter'];
    surfaces.push(
      new mod.WhatsAppClarifySurface({
        adapter: waAdapter,
        bridge,
        store: bridge.store,
        getSessionRouting,
      }),
    );
  }
  return surfaces;
}

// ---------------------------------------------------------------------------
// Gateway-role construction seams
// ---------------------------------------------------------------------------
//
// plan/phases/single-process-boot-profile.md §3a/§7 Phase 1: the constructor
// logic below used to sit inline inside `runGatewayStart`, which meant a third
// entry point (the merged `boot` profile of §6) could only reuse it by
// copy-pasting. Each unit is now a named, exported, individually-callable
// function that `runGatewayStart` calls in place of the inline code —
// behavior-identical, same order, same arguments.
//
// They live in THIS file rather than a sibling module on purpose:
// `apps/ethos/src/__tests__/daemon-free-smoke.test.ts` asserts that
// `commands/gateway.ts` is the ONLY file under `apps/ethos/src/` that imports
// `@ethosagent/gateway`, and every one of these needs a type or a value from
// it. Moving them out would break the daemon-free doctrine gate.

/**
 * The shared attachment cache every platform adapter and the `Gateway` read
 * from, plus its hourly TTL sweep.
 *
 * Extracted verbatim from `runGatewayStart`. The timer is returned rather than
 * hidden because the caller owns teardown — `runGatewayStart`'s `shutdown`
 * clears it.
 */
/**
 * The gateway role's voice-OUTPUT machinery: the lane voice-mode store, the
 * ffmpeg transcode stage, the synthesized-artifact store, and the two derived
 * channel-egress settings.
 *
 * Extracted verbatim from `runGatewayStart` (plan §3b step 5). Built ONCE per
 * process and handed to whichever `Gateway` `buildGateway` constructs — a
 * second store would mean two caches over the same file and two artifact dirs
 * over the same bytes, which is exactly the double-construction hazard the
 * merged `boot` profile has to avoid (plan §3c).
 */
export function buildGatewayVoiceOutputs(
  config: EthosConfig,
  storage: import('@ethosagent/types').Storage,
): {
  voiceModeStore: LaneVoiceModeStore;
  transcoder: ReturnType<typeof createFfmpegTranscoder>;
  voiceArtifacts: ReturnType<typeof createVoiceArtifactStore>;
  channelVoiceOut: ReturnType<typeof deriveChannelVoiceOut>;
  voiceBitrateKbps: number | undefined;
} {
  const logLevel = config.logs?.level;
  // The store carries the deployment default, so `defaultVoiceMode` is not also
  // passed: an injected store's own default is the one the Gateway reads.
  const voiceModeStore = new LaneVoiceModeStore({
    storage,
    path: laneVoiceModePath(ethosDir()),
    ...(config.voice?.defaultMode ? { defaultMode: config.voice.defaultMode } : {}),
    onError: (err) => {
      new ConsoleLogger({}, logLevel).warn(`voice lane-mode persist failed: ${err}`);
    },
  });
  // ffmpeg stage. Optional at runtime: an unavailable binary degrades to
  // pass-through, and the startup probe in the caller says so once.
  const transcoder = createFfmpegTranscoder({
    ...(config.voice?.transcode?.ffmpegPath
      ? { ffmpegPath: config.voice.transcode.ffmpegPath }
      : {}),
    // `voice.transcode.timeout` is SECONDS; the option is milliseconds.
    timeoutMs: (config.voice?.transcode?.timeout ?? 30) * 1000,
  });
  // Synthesized audio has to outlive a failed send: redelivery re-sends THOSE
  // bytes rather than re-synthesizing, which would be a different take.
  const voiceArtifacts = createVoiceArtifactStore({
    storage,
    dir: join(ethosDir(), 'voice', 'artifacts'),
    onError: (op, err) => {
      new ConsoleLogger({}, logLevel).warn(`voice artifact ${op} failed: ${err}`);
    },
  });
  return {
    voiceModeStore,
    transcoder,
    voiceArtifacts,
    channelVoiceOut: deriveChannelVoiceOut(config.voice?.channels),
    voiceBitrateKbps: config.voice?.transcode?.bitrateKbps,
  };
}

/**
 * Re-exported from `@ethosagent/gateway` so the merged `boot` profile can use
 * them without importing the gateway package itself —
 * `apps/ethos/src/__tests__/daemon-free-smoke.test.ts` allows exactly one file
 * under `apps/ethos/src/` to do that, and this is it. `createCapturingAdapter`
 * wires the inbound-webhook server; `adapterRegistries` is the adapter
 * derivation boot's per-bot lookup must share with the Gateway `buildGateway`
 * builds.
 */
export { adapterRegistries, createCapturingAdapter };

export async function createGatewayAttachmentCache(
  storage: import('@ethosagent/types').Storage,
): Promise<{
  attachmentCache: import('@ethosagent/types').AttachmentCache;
  pruneTimer: NodeJS.Timeout;
}> {
  const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
  const attachmentCache = new FsAttachmentCache(storage, join(ethosDir(), 'cache', 'attachments'));
  // TTL sweep — prune cached attachments older than 24 h every hour.
  const pruneTimer = setInterval(
    () => {
      void attachmentCache.pruneOlderThan(24 * 60 * 60 * 1000).catch(() => {});
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref?.();
  return { attachmentCache, pruneTimer };
}

/**
 * Construct every configured channel adapter for the gateway role (plan §3b
 * step 5, "channel adapters *constructed* but not started").
 *
 * `buildAdapters` was already a named export; what was still inline in
 * `runGatewayStart` — and is now here — is the WhatsApp QR / pairing-code
 * reporting the gateway role wires around it: the code is printed to the
 * console AND pushed to the web API's pairing surface, so an operator can
 * link a device from either place.
 */
export async function buildGatewayAdapters(
  config: EthosConfig,
  attachmentCache: import('@ethosagent/types').AttachmentCache,
): Promise<PlatformAdapter[]> {
  return buildAdapters(config, loadAdapterModule, attachmentCache, {
    onWhatsAppQr: (botId, qr) => {
      import('@ethosagent/web-api').then((m) => m.setWhatsAppQr(botId, qr)).catch(() => {});
    },
    onWhatsAppPairingCode: (botId, code) => {
      if (code !== null) {
        console.log(
          `\n  ${c.bold}WhatsApp pairing code for "${botId}": ${c.cyan}${code}${c.reset}\n` +
            `  ${c.dim}On that phone: WhatsApp \u2192 Linked Devices \u2192 Link with phone number instead \u2192 enter the code.${c.reset}\n`,
        );
      }
      import('@ethosagent/web-api')
        .then((m) => m.setWhatsAppPairingCode(botId, code))
        .catch(() => {});
    },
  });
}

/**
 * Register the per-platform clarify surfaces and derive the Gateway's
 * `clarifyMessageCorrelator`.
 *
 * Extracted verbatim from `runGatewayStart` (plan §3b step 5, "clarify
 * surfaces registered per platform"). `resolveApprovalRoute` is the caller's
 * late-bound handle on the not-yet-constructed Gateway — the surfaces and the
 * Gateway each need a reference to the other, so the caller passes a closure
 * over its own mutable holder rather than the Gateway itself.
 *
 * Telegram and WhatsApp are text-only surfaces, so they correlate a reply by
 * matching an inbound message; Slack and Discord register their own
 * interaction listeners on the adapter and contribute nothing to the
 * correlator.
 */
export async function registerGatewayClarifySurfaces(opts: {
  bots: GatewayBotConfig[];
  adapters: PlatformAdapter[];
  systemLoop: AgentLoop;
  resolveApprovalRoute: (
    sessionId: string,
  ) => { chatId: string; threadId?: string; requesterUserId?: string } | undefined;
}): Promise<{
  clarifyMessageCorrelator?: (msg: InboundMessage) => Promise<ClarifyResponse | null>;
}> {
  const { bots, adapters, systemLoop, resolveApprovalRoute } = opts;
  const telegramClarifySurfaces = await buildTelegramClarifySurfaces(
    bots,
    adapters,
    (sessionId) => {
      const route = resolveApprovalRoute(sessionId);
      if (!route) return undefined;
      return route.requesterUserId !== undefined
        ? { chatId: route.chatId, requesterUserId: route.requesterUserId }
        : { chatId: route.chatId };
    },
  );
  // Slack clarify surfaces are wired identically — only the surface module
  // and the routing fields differ (Slack carries a `threadId` for thread
  // routing). The surfaces register their own `block_actions` /
  // `view_submission` listeners on the adapter; the gateway never calls into
  // them directly, so they don't contribute to `clarifyMessageCorrelator`.
  await buildSlackClarifySurfaces(bots, adapters, (sessionId) => {
    const route = resolveApprovalRoute(sessionId);
    if (!route) return undefined;
    return {
      chatId: route.chatId,
      ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
      ...(route.requesterUserId !== undefined ? { requesterUserId: route.requesterUserId } : {}),
    };
  });
  // Discord clarify surfaces — same pattern as Slack but no thread routing.
  // Discord delivers component clicks via `interactionCreate`, which the
  // surface registers on directly via `adapter.onClarifyInteraction`.
  // Discord now appears in `buildGatewayBots`, so the surface binds to that
  // per-bot loop's bridge; `systemLoop` remains the fallback for the rare
  // case where no bot entry matched.
  await buildDiscordClarifySurfaces(bots, adapters, systemLoop, (sessionId) => {
    const route = resolveApprovalRoute(sessionId);
    if (!route) return undefined;
    return {
      chatId: route.chatId,
      ...(route.requesterUserId !== undefined ? { requesterUserId: route.requesterUserId } : {}),
    };
  });
  // WhatsApp clarify surfaces — text-only (Baileys cannot send buttons or
  // lists), so like Telegram they resolve through `correlateMessage`.
  const whatsAppClarifySurfaces = await buildWhatsAppClarifySurfaces(
    bots,
    adapters,
    (sessionId) => {
      const route = resolveApprovalRoute(sessionId);
      if (!route) return undefined;
      return route.requesterUserId !== undefined
        ? { chatId: route.chatId, requesterUserId: route.requesterUserId }
        : { chatId: route.chatId };
    },
  );
  const correlatingClarifySurfaces = [...telegramClarifySurfaces, ...whatsAppClarifySurfaces];
  const clarifyMessageCorrelator =
    correlatingClarifySurfaces.length > 0
      ? async (msg: InboundMessage): Promise<ClarifyResponse | null> => {
          for (const surface of correlatingClarifySurfaces) {
            const r = await surface.correlateMessage(msg);
            if (r) return r;
          }
          return null;
        }
      : undefined;
  return clarifyMessageCorrelator ? { clarifyMessageCorrelator } : {};
}

/**
 * The `channel-digest` system cron task (plan/phases/ambient-group-monitoring.md
 * R3/R9/R10), shared by `ethos gateway start` and `ethos boot`.
 *
 * NOT in `buildSystemTaskHandlers`: every input the digest needs — the
 * transcript store, the per-bot loops, the botKey-keyed adapters, the owner in
 * `channel_filter` — is private to the live Gateway, which that shared table
 * has no handle on. `ethos serve` has no adapters and therefore no digest, and
 * `systemJobSpecs` omits the job from serve's roster rather than listing it
 * disabled: a disabled spec is REMOVED, so serve would otherwise delete the job
 * the gateway seeded, on every restart, forever.
 *
 * `getGateway` is a getter rather than the Gateway itself because the cron
 * scheduler is constructed before the Gateway exists. By the time a job can
 * fire (`cronTriggers.local.start()` runs after `buildGateway`) it is set.
 */
export function channelDigestSystemTask(
  config: EthosConfig,
  getGateway: () => Gateway | null,
  opts: { inAppSink?: boolean } = {},
): () => Promise<{ output: string }> {
  // `deliverTo: 'inApp'` makes the in-app feed the digest's ENTIRE delivery.
  // Only `ethos boot` has a feed to give the Gateway (`channelDigestFeed`);
  // under `ethos gateway` there is no in-process web API, so every digest
  // would be summarised — a paid LLM pass over a watched room — and dropped.
  // Refuse at startup, where an operator sees it, rather than discarding
  // nightly. `enabled` is checked too: a `deliverTo` left in the config of a
  // digest nobody turned on is not a reason to refuse to start.
  if (config.channelDigest?.enabled === true && config.channelDigest.deliverTo === 'inApp') {
    if (opts.inAppSink !== true) {
      throw new EthosError({
        code: 'CONFIG_INVALID',
        cause:
          "channelDigest.deliverTo is 'inApp', but this command has no in-app notifications feed — every digest would be generated and discarded.",
        action:
          'Run `ethos boot`, which serves the web UI, or set `channelDigest.deliverTo: owner` in ~/.ethos/config.yaml.',
      });
    }
  }
  return async () => {
    const gateway = getGateway();
    if (!gateway) return { output: 'Channel digest skipped — the gateway is not running' };
    const cd = config.channelDigest ?? {};
    const report = await gateway.runChannelDigest({
      ...(cd.deliverTo ? { deliverTo: cd.deliverTo } : {}),
      ...(cd.maxMessagesPerLane !== undefined ? { maxMessagesPerLane: cd.maxMessagesPerLane } : {}),
      ...(cd.maxLanesPerRun !== undefined ? { maxLanesPerRun: cd.maxLanesPerRun } : {}),
      ...(cd.costWarnUsdPerLane !== undefined ? { costWarnUsdPerLane: cd.costWarnUsdPerLane } : {}),
    });
    return { output: summarizeChannelDigest(report) };
  };
}

/**
 * The observe-mode transcript sink, opened on FIRST WRITE.
 *
 * `new SQLiteChannelTranscriptStore(path)` creates the file and runs the
 * migration in its constructor, so building one at startup would drop a
 * `channel-transcript.db` into `~/.ethos/` on every machine — including the
 * overwhelming majority that have never set a chat to observe. The file
 * existing is the signal that something is being recorded, and it should mean
 * that. So this is a thin deferral: nothing is opened until a message actually
 * needs writing.
 *
 * The READS do not open it either. Enabling the channel digest on a deployment
 * that has observed nothing would otherwise create and migrate the database on
 * the digest's first `listLanes` — the same file, appearing for the same wrong
 * reason, one caller later. A read against a database that does not exist has
 * an honest answer, and it is "nothing", so that is what they return. Once a
 * write has opened the connection the reads go through it as before.
 *
 * `close()` closes only what was opened — a process that never recorded has
 * nothing to close.
 */
export function openChannelTranscriptStore(dbPath: string): ChannelTranscriptStore {
  let store: SQLiteChannelTranscriptStore | undefined;
  const open = (): SQLiteChannelTranscriptStore => {
    store ??= new SQLiteChannelTranscriptStore(dbPath);
    return store;
  };
  /** The live connection, or undefined while there is nothing to read. */
  const opened = (): SQLiteChannelTranscriptStore | undefined =>
    store ?? (existsSync(dbPath) ? open() : undefined);
  return {
    record: (entry) => open().record(entry),
    readSince: async (laneKey, since, options) =>
      (await opened()?.readSince(laneKey, since, options)) ?? { messages: [], omittedCount: 0 },
    listLanes: async (options) => (await opened()?.listLanes(options)) ?? [],
    close: () => store?.close(),
  };
}

/**
 * The one-time startup warning for team deployments with no trusted rooms
 * (plan personality-memory-boundary G1, verification rounds B9/E7): a task a
 * team channel creates is stamped shared, so every worker that runs it has
 * every tool in `SHARED_AUDIENCE_EXCLUDED_TOOLS` withheld — the shell and
 * process tools, team memory, the mesh tools and the rest — fail closed, and
 * surprising the first time a team loses its shell. The warning names the
 * whole list, read from the constant so it cannot drift. Listing the team's
 * own channel in `gateway.private_chats.<platform>` restores them.
 * `undefined` when no bot is team-bound or any room is listed. Printed once
 * by `buildGateway`; pinned by
 * `apps/ethos/src/__tests__/team-private-chats-warning.test.ts`.
 */
export function teamPrivateChatsWarning(
  bots: ReadonlyArray<Pick<GatewayBotConfig, 'binding'>>,
  privateChats: Readonly<Record<string, readonly string[]>> | undefined,
): string | undefined {
  const teams = bots.flatMap((b) => (b.binding.type === 'team' ? [b.binding.name] : []));
  if (teams.length === 0) return undefined;
  const listed = Object.values(privateChats ?? {}).some((ids) => ids.length > 0);
  if (listed) return undefined;
  return (
    `team ${[...new Set(teams)].join(', ')}: gateway.private_chats is empty, so every team ` +
    'channel is a shared room — tasks created there run on every worker without private ' +
    `memory and without these tools: ${SHARED_AUDIENCE_EXCLUDED_TOOLS.join(', ')}. ` +
    "If the channel is only your team's, list it under gateway.private_chats.<platform> " +
    'and restart.'
  );
}

export function buildGateway(opts: BuildGatewayOptions): Gateway {
  const {
    config,
    bots,
    systemLoop,
    idleBotJobs,
    adapters,
    deliveryLedger,
    inboundDedup,
    heldNotices,
    inboundSpool,
    inboundSpoolOptions,
    resolveUserId,
    pluginLoader,
    trustedChannelPlugins,
    notificationRouter: gatewayNotificationRouter,
    storage,
    attachmentCache,
    sttProviders,
    ttsProviders,
    voiceConfig,
    voiceModeStore,
    voiceArtifacts,
    transcoder,
    channelVoiceOut,
    voiceBitrateKbps,
    personalityDirectory,
    onTurnComplete,
    onUserTurn,
    streamingEdits,
    pairingDb,
    channelTranscript,
    channelDigestFeed,
    clarifyMessageCorrelator,
    personalityCardReader: telegramCardReader,
    greetingProvider: telegramGreetingProvider,
    publicationSpeaksFor,
    observability,
  } = opts;
  // Observe mode records nothing without `channelTranscript`. Both branches
  // below wire one, so this stays silent here — it is the light for a
  // deployment that assembles its own Gateway and forgets the sink. See
  // `GatewayConfig.observeModePlatforms`.
  const observedPlatforms = observeModePlatforms(config);
  const quietHours = resolveGatewayQuietHours(config.notifications);
  // Trusted rooms (plan personality-memory-boundary D9), read once here: a
  // `gateway.private_chats` edit needs a restart (`config-reload.ts` says so).
  const privateChats = config.gateway?.privateChats
    ? privateChatSetFrom(config.gateway.privateChats)
    : undefined;
  const teamWarning = teamPrivateChatsWarning(bots, config.gateway?.privateChats);
  if (teamWarning) console.warn(`${c.yellow}⚠${c.reset} ${c.dim}${teamWarning}${c.reset}`);
  const { adapters: adapterMap, botAdapters } = adapterRegistries(adapters);
  return bots.length === 0
    ? // No platform configured — idle gateway. Every configured platform
      // (including Discord/Email) now registers a bot in `buildGatewayBots`,
      // so this single-loop path is reached only when nothing is wired up.
      new Gateway({
        bots: [idleGatewayBot(systemLoop, config.personality, idleBotJobs)],
        adapters: adapterMap,
        botAdapters,
        deliveryLedger,
        inboundDedup,
        ...(heldNotices ? { heldNotices } : {}),
        ...(quietHours ? { quietHours } : {}),
        ...(inboundSpool ? { inboundSpool } : {}),
        ...(inboundSpoolOptions ? { inboundSpoolOptions } : {}),
        resolveUserId,
        pluginLoader,
        pluginAdapters: pluginLoader.getPlatformAdapters(),
        trustedChannelPlugins,
        notificationRouter: gatewayNotificationRouter,
        sttProviderRegistry: sttProviders,
        sttProviderName: voiceConfig.sttProviderName,
        sttProviderConfig: voiceConfig.sttProviderConfig,
        ttsProviderRegistry: ttsProviders,
        ttsProviderName: voiceConfig.ttsProviderName,
        ttsProviderConfig: voiceConfig.ttsProviderConfig,
        // The named rosters (`voice.stt.providers.*` / `voice.tts.providers.*`)
        // a personality's `voice.stt_provider` / `voice.tts_provider` selects
        // from. Without them the gateway resolves every lane onto the default
        // entry, so per-personality voice would be live in `buildVoiceStack`
        // and silently inert on every channel.
        ...(voiceConfig.sttRoster ? { sttProviderRoster: voiceConfig.sttRoster } : {}),
        ...(voiceConfig.ttsRoster ? { ttsProviderRoster: voiceConfig.ttsRoster } : {}),
        voiceSecretsResolver: voiceConfig.secretsResolver,
        // Local-only voice-egress gate (`voice.trustedPlugins`); undefined = off.
        ...(voiceConfig.trustedVoicePlugins
          ? { trustedVoicePlugins: voiceConfig.trustedVoicePlugins }
          : {}),
        // Where a NEW lane starts (`voice.defaultMode`); `/voice` still wins
        // per lane, and the store persists that choice across restarts.
        voiceModeStore,
        voiceArtifacts,
        transcoder,
        ...(channelVoiceOut ? { channelVoiceOut } : {}),
        ...(voiceBitrateKbps !== undefined ? { voiceBitrateKbps } : {}),
        personalityDirectory,
        onTurnComplete,
        onUserTurn,
        streamingEdits,
        // H1 — `display.slow_turn_notice_ms`; absent → the gateway's 8000
        // default, 0 disables (plan ux-feedback-and-config-clarity, UD3).
        ...(config.displaySlowTurnNoticeMs !== undefined
          ? { slowTurnNoticeMs: config.displaySlowTurnNoticeMs }
          : {}),
        ...(config.channelToolsets ? { channelToolsets: config.channelToolsets } : {}),
        ...(config.channelFilter ? { channelFilter: config.channelFilter } : {}),
        ...(privateChats ? { privateChats } : {}),
        ...(pairingDb ? { pairingDb } : {}),
        channelTranscript,
        ...(channelDigestFeed ? { channelDigestFeed } : {}),
        observeModePlatforms: observedPlatforms,
        publicationSpeaksFor,
        observability,
        // openclaw-9.5 item 1 — the plugin-credential link a refused lane gets.
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
      })
    : new Gateway({
        bots,
        attachmentCache,
        botAdapters,
        // Reading cached attachment bytes: an inbound voice note is
        // transcribed from the audio itself, not from a path.
        storage,
        // Where gateway-owned state files go — today the channel digest's
        // per-lane watermarks and the run lock that brackets them. `Storage`
        // does not root relative paths, so this is what keeps those files in
        // `~/.ethos/` rather than in the cwd — which for a daemon is wherever
        // it happened to be started, and would put two processes' locks in two
        // different directories. Also where the per-bot lane files live
        // (`gateway/lanes/<botKey>.json`, D28).
        dataDir: ethosDir(),
        // `/fork`, `/branches`, `/branch <n>` — opened on first use and closed
        // with the Slack readers by `closeSlackSessionStores()` at shutdown.
        sessionStore: openBranchSessionStore,
        // D5 — each bot's `budget.dailyUsd` is enforced against this.
        botSpendSince: (scope, since) => botSpendSince(scope, since),
        adapters: adapterMap,
        deliveryLedger,
        inboundDedup,
        ...(heldNotices ? { heldNotices } : {}),
        ...(quietHours ? { quietHours } : {}),
        ...(inboundSpool ? { inboundSpool } : {}),
        ...(inboundSpoolOptions ? { inboundSpoolOptions } : {}),
        resolveUserId,
        pluginLoader,
        pluginAdapters: pluginLoader.getPlatformAdapters(),
        trustedChannelPlugins,
        notificationRouter: gatewayNotificationRouter,
        sttProviderRegistry: sttProviders,
        sttProviderName: voiceConfig.sttProviderName,
        sttProviderConfig: voiceConfig.sttProviderConfig,
        ttsProviderRegistry: ttsProviders,
        ttsProviderName: voiceConfig.ttsProviderName,
        ttsProviderConfig: voiceConfig.ttsProviderConfig,
        // The named rosters (`voice.stt.providers.*` / `voice.tts.providers.*`)
        // a personality's `voice.stt_provider` / `voice.tts_provider` selects
        // from. Without them the gateway resolves every lane onto the default
        // entry, so per-personality voice would be live in `buildVoiceStack`
        // and silently inert on every channel.
        ...(voiceConfig.sttRoster ? { sttProviderRoster: voiceConfig.sttRoster } : {}),
        ...(voiceConfig.ttsRoster ? { ttsProviderRoster: voiceConfig.ttsRoster } : {}),
        voiceSecretsResolver: voiceConfig.secretsResolver,
        // Local-only voice-egress gate (`voice.trustedPlugins`); undefined = off.
        ...(voiceConfig.trustedVoicePlugins
          ? { trustedVoicePlugins: voiceConfig.trustedVoicePlugins }
          : {}),
        // Where a NEW lane starts (`voice.defaultMode`); `/voice` still wins
        // per lane, and the store persists that choice across restarts.
        voiceModeStore,
        voiceArtifacts,
        transcoder,
        ...(channelVoiceOut ? { channelVoiceOut } : {}),
        ...(voiceBitrateKbps !== undefined ? { voiceBitrateKbps } : {}),
        personalityDirectory,
        onTurnComplete,
        onUserTurn,
        streamingEdits,
        // H1 — same wiring as the idle branch above.
        ...(config.displaySlowTurnNoticeMs !== undefined
          ? { slowTurnNoticeMs: config.displaySlowTurnNoticeMs }
          : {}),
        ...(config.channelToolsets ? { channelToolsets: config.channelToolsets } : {}),
        ...(clarifyMessageCorrelator ? { clarifyMessageCorrelator } : {}),
        ...(telegramCardReader ? { personalityCardReader: telegramCardReader } : {}),
        ...(telegramGreetingProvider ? { greetingProvider: telegramGreetingProvider } : {}),
        ...(config.channelFilter ? { channelFilter: config.channelFilter } : {}),
        ...(privateChats ? { privateChats } : {}),
        ...(pairingDb ? { pairingDb } : {}),
        channelTranscript,
        ...(channelDigestFeed ? { channelDigestFeed } : {}),
        observeModePlatforms: observedPlatforms,
        publicationSpeaksFor,
        observability,
        // openclaw-9.5 item 1 — the plugin-credential link a refused lane gets.
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
      });
}
