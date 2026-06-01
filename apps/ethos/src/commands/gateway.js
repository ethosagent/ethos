import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CronScheduler } from '@ethosagent/cron';
import { Gateway } from '@ethosagent/gateway';
import { ConsoleLogger } from '@ethosagent/logger';
import { createPersonalityRegistry, firstParagraph } from '@ethosagent/personalities';
import { initPairingDb } from '@ethosagent/safety-channel';
import { createInjectors } from '@ethosagent/skills';
import { bundledSkillsSource } from '@ethosagent/skills-library';
import { readRuntime, removeRuntime } from '@ethosagent/team-supervisor';
// Platform adapters are loaded LAZILY in runGatewayStart() — see plan/IMPROVEMENT.md P0-3.
// Their underlying SDKs (grammy, discord.js, @slack/bolt, imapflow…) are
// optionalDependencies of @ethosagent/cli. A failed install for any one of
// them must not crash the CLI for users who don't run that platform.
import { EthosError, resolveModelDisplay } from '@ethosagent/types';
import { createDangerPredicate, createMemoryProvider, IdentityMap } from '@ethosagent/wiring';
import Database from 'better-sqlite3';
import { ApprovalCoordinator, createSlackApprovalHook } from '../approval-coordinator';
import {
  applyPlatformShim,
  deriveBotKey,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  validateBotBindings,
  writeConfig,
} from '../config';
import { createHealthServer } from '../health-server';
import { emitReady } from '../logger';
import { migrateSessionKeysIfNeeded } from '../migrations/session-keys-multi-bot';
import { notifyReady, startWatchdog } from '../sd-notify';
import { createAgentLoop, createTeamAgentLoop, getSecretsResolver, getStorage } from '../wiring';
import { ensureTeamSupervisors, stopTeamSupervisors } from './supervisor-lifecycle';
import { isPidAlive } from './team-runtime';

// ---------------------------------------------------------------------------
// Gateway heartbeat
// ---------------------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('health check timeout')), ms).unref(),
    ),
  ]);
}
export async function buildGatewayHeartbeat(adapters, startedAt) {
  const results = await Promise.allSettled(
    adapters.map((a) => withTimeout(a.health(), HEALTH_TIMEOUT_MS)),
  );
  const adapterStatuses = adapters.map((a, i) => {
    const result = results[i];
    const ok = result?.status === 'fulfilled' ? result.value.ok : false;
    return { name: a.id, ok };
  });
  return {
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    adapters: adapterStatuses,
  };
}
function gatewayHealthPath() {
  return join(ethosDir(), 'gateway-health.json');
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
async function loadAdapterModule(modulePath, label) {
  try {
    let mod;
    switch (modulePath) {
      case '@ethosagent/platform-telegram':
        mod = await import('@ethosagent/platform-telegram');
        break;
      case '@ethosagent/platform-slack':
        mod = await import('@ethosagent/platform-slack');
        break;
      case '@ethosagent/platform-discord':
        mod = await import('@ethosagent/platform-discord');
        break;
      case '@ethosagent/platform-email':
        mod = await import('@ethosagent/platform-email');
        break;
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
      default:
        throw new EthosError({
          code: 'INTERNAL',
          cause: `loadAdapterModule: unknown module '${modulePath}'`,
          action:
            'Add a literal-string switch arm in apps/ethos/src/commands/gateway.ts so the bundler can inline this module.',
        });
    }
    return mod;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${c.yellow}⚠ ${label} adapter unavailable${c.reset} ${c.dim}(${reason})${c.reset}`,
    );
    return null;
  }
}
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
// ---------------------------------------------------------------------------
// ethos gateway setup
// ---------------------------------------------------------------------------
export async function runGatewaySetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
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
    const data = await res.json();
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
  await writeConfig(storage, { ...config, telegramToken: token });
  console.log(`${c.green}✓ Token saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos gateway start${c.reset}${c.dim} to start the bot.${c.reset}\n`,
  );
}
// ---------------------------------------------------------------------------
// ethos gateway start
// ---------------------------------------------------------------------------
export async function runGatewayStart() {
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
  if (loaded.parseErrors.length > 0) {
    console.log(`${c.red}Config parse errors:${c.reset}`);
    for (const err of loaded.parseErrors) console.log(`  • ${err}`);
    process.exit(1);
  }
  for (const note of loaded.deprecations) {
    console.log(`${c.yellow}⚠ deprecation${c.reset} ${c.dim}${note}${c.reset}`);
  }
  const config = loaded.config;
  const identityMap = new IdentityMap({ storage, dataDir: ethosDir() });
  const resolveUserId = (platform, platformUserId, displayLabel) =>
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
  // Multi-bot routing has a known limitation in v1: email and discord
  // continue to use a single legacy adapter without botKey stamping.
  // When multi-bot telegram/slack is configured alongside email/discord,
  // those legacy adapters' messages have no botKey, and the Gateway has
  // no `defaultBotKey` to fall back on (defaultBotKey only fires for
  // single-bot deployments). Warn at boot so operators know.
  const multiBotConfigured =
    (config.telegram?.bots.length ?? 0) +
      (config.slack?.apps.length ?? 0) +
      (config.whatsapp?.length ?? 0) >
    1;
  const legacyAdapterConfigured =
    !!config.discordToken ||
    !!(config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost);
  if (multiBotConfigured && legacyAdapterConfigured) {
    console.log(
      `${c.yellow}⚠${c.reset} ${c.dim}Multi-bot routing is configured alongside email/discord. ` +
        `Email and Discord inbound messages will not be routed in v1 — they have no botKey. ` +
        `Use single-bot configs or wait for v1.1 multi-bot email/discord.${c.reset}`,
    );
  }
  // Validate bot bindings against the on-disk personality registry and
  // team manifests. Fail loudly here rather than letting messages route
  // to a non-existent destination at first request.
  const bindErrors = await validateBindings(config);
  if (bindErrors.length > 0) {
    console.log(`${c.red}Bot binding errors:${c.reset}`);
    for (const err of bindErrors) console.log(`  • ${err}`);
    process.exit(1);
  }
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
  let systemLoop = null;
  let cronPersonalities = null;
  // Forward-reference: filled after the Gateway + adapters are built.
  let cronDeliverFn = null;
  const scheduler = new CronScheduler({
    logger: new ConsoleLogger(),
    deliver: async (job, output) => {
      if (cronDeliverFn) await cronDeliverFn(job, output);
    },
    runJob: async (job) => {
      if (!systemLoop) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: 'System loop not yet initialised at cron firing time',
          action:
            'This is a wiring bug — the scheduler started before the agent loop was assigned. File an issue.',
        });
      }
      // Recursion guard: exclude 'cron' from the effective toolset so
      // cron-spawned sessions cannot schedule further cron jobs.
      if (!cronPersonalities) {
        cronPersonalities = await createPersonalityRegistry();
        await cronPersonalities.loadFromDirectory(join(ethosDir(), 'personalities'));
      }
      const pid = job.personalityId;
      const pers = cronPersonalities.get(pid);
      const toolsetOverride = pers?.toolset?.filter((t) => t !== 'cron');
      const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
      let output = '';
      for await (const event of systemLoop.run(job.prompt, {
        sessionKey,
        personalityId: pid,
        toolsetOverride,
      })) {
        if (event.type === 'text_delta') output += event.text;
      }
      return { jobId: job.id, ranAt: new Date().toISOString(), output, sessionKey };
    },
  });
  // Build one AgentLoop per configured bot. Personality bots use
  // `createAgentLoop`; team bots use `createTeamAgentLoop`. Each loop
  // receives the shared `scheduler` so its `cron` tool lands in the
  // same scheduler store as everything else.
  const { bots, messagingSetters: botMessagingSetters } = await buildGatewayBots(config, scheduler);
  // Phase 3: for each team-bound bot, ensure the supervisor is running.
  const supervisorDeps = {
    readRuntime,
    removeRuntime,
    isPidAlive,
    spawn,
    kill: (pid, signal) => process.kill(pid, signal),
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
  // System loop used by cron — not bot-bound. Cron jobs route through
  // their own `job.personalityId` field, not through the platform bot
  // routing table. The scheduler is passed in so agent-callable cron
  // tools register against the same instance the firing engine uses.
  const { loop: systemLoopReady, setMessagingSend: setSystemMessagingSend } = await createAgentLoop(
    config,
    { cronScheduler: scheduler },
  );
  systemLoop = systemLoopReady;
  // Shared attachment cache for all platform adapters. Hoisted here so the
  // same instance flows into both `buildAdapters` (Telegram, Slack) and the
  // `Gateway` (cleanup on /new and lane eviction).
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
  // Build and register all configured adapters early so we can wire the
  // clarify surfaces *before* constructing the Gateway. The surfaces' combined
  // `correlateMessage` is passed in as `clarifyMessageCorrelator`. The
  // surface's `getSessionRouting` closes over a mutable holder filled in
  // right after Gateway construction — necessary because the surface and the
  // Gateway each need a reference to the other.
  const adapters = await buildAdapters(config, loadAdapterModule, attachmentCache, {
    onWhatsAppQr: (botId, qr) => {
      import('@ethosagent/web-api').then((m) => m.setWhatsAppQr(botId, qr)).catch(() => {});
    },
    onWhatsAppPairingCode: (botId, code) => {
      if (code !== null) {
        console.log(
          `\n  ${c.bold}WhatsApp pairing code for "${botId}": ${c.cyan}${code}${c.reset}\n` +
            `  ${c.dim}On that phone: WhatsApp → Linked Devices → Link with phone number instead → enter the code.${c.reset}\n`,
        );
      }
      import('@ethosagent/web-api')
        .then((m) => m.setWhatsAppPairingCode(botId, code))
        .catch(() => {});
    },
  });
  let gatewayRef = null;
  const telegramClarifySurfaces = await buildTelegramClarifySurfaces(
    bots,
    adapters,
    (sessionId) => {
      const route = gatewayRef?.resolveApprovalRoute(sessionId);
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
    const route = gatewayRef?.resolveApprovalRoute(sessionId);
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
  // `systemLoop` is the fallback bridge for the legacy single-Discord
  // deployment (no telegram/slack bots configured) — Discord doesn't yet
  // appear in `buildGatewayBots`, so per-bot lookup misses and we use
  // the system loop's bridge instead.
  await buildDiscordClarifySurfaces(bots, adapters, systemLoop, (sessionId) => {
    const route = gatewayRef?.resolveApprovalRoute(sessionId);
    if (!route) return undefined;
    return {
      chatId: route.chatId,
      ...(route.requesterUserId !== undefined ? { requesterUserId: route.requesterUserId } : {}),
    };
  });
  const clarifyMessageCorrelator =
    telegramClarifySurfaces.length > 0
      ? async (msg) => {
          for (const surface of telegramClarifySurfaces) {
            const r = await surface.correlateMessage(msg);
            if (r) return r;
          }
          return null;
        }
      : undefined;
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
  let pairingDb;
  if (config.channelFilter) {
    const dbPath = join(ethosDir(), 'pairing.db');
    pairingDb = new Database(dbPath);
    pairingDb.pragma('journal_mode = WAL');
    initPairingDb(pairingDb);
  }
  // Build adapter registry for send_message cross-platform routing.
  // Derive platform key from adapter.id prefix (e.g. 'telegram:bot-1' → 'telegram',
  // 'email' → 'email'). This is a stable identifier, unlike displayName which is UI text.
  const adapterMap = new Map();
  for (const adapter of adapters) {
    const colonIdx = adapter.id.indexOf(':');
    const platformKey = colonIdx > 0 ? adapter.id.slice(0, colonIdx) : adapter.id;
    // First adapter per platform wins (multi-bot: all share the same send path)
    if (!adapterMap.has(platformKey)) {
      adapterMap.set(platformKey, adapter);
    }
  }
  const gateway =
    bots.length === 0
      ? // Email-only deployment (no telegram/slack bots configured). Keep
        // the legacy single-loop construction for the email path.
        new Gateway({
          loop: systemLoop,
          defaultPersonality: config.personality,
          adapters: adapterMap,
          resolveUserId,
          showToolCalls: process.env.ETHOS_CHANNEL_TOOL_CALLS !== 'false',
          ...(config.channelFilter ? { channelFilter: config.channelFilter } : {}),
          ...(pairingDb ? { pairingDb } : {}),
        })
      : new Gateway({
          bots,
          attachmentCache,
          adapters: adapterMap,
          resolveUserId,
          showToolCalls: process.env.ETHOS_CHANNEL_TOOL_CALLS !== 'false',
          ...(clarifyMessageCorrelator ? { clarifyMessageCorrelator } : {}),
          ...(telegramCardReader ? { personalityCardReader: telegramCardReader } : {}),
          ...(telegramGreetingProvider ? { greetingProvider: telegramGreetingProvider } : {}),
          ...(config.channelFilter ? { channelFilter: config.channelFilter } : {}),
          ...(pairingDb ? { pairingDb } : {}),
        });
  gatewayRef = gateway;
  // Wire send_message tool to the real Gateway send path.
  // Each loop's messaging send function is scoped — set on all active loops.
  const gatewayMessagingSend = async (platform, target, body) =>
    gateway.sendTo(platform, target, body);
  setSystemMessagingSend(gatewayMessagingSend);
  for (const setter of botMessagingSetters) {
    setter(gatewayMessagingSend);
  }
  // Wire cron delivery through the gateway's sendTo path so origin-bearing
  // jobs route output back to the channel they were created from.
  cronDeliverFn = async (job, output) => {
    if (!job.origin) return;
    await gateway.sendTo(job.origin.platform, job.origin.chatId, output);
  };
  // Index bots by botKey so health-check lines can show the binding inline.
  const botByKey = new Map(bots.map((b) => [b.botKey, b]));
  if (adapters.length === 0) {
    console.log(
      `${c.dim}No adapters started — gateway idling. Configure a platform to activate.${c.reset}`,
    );
  }
  // Wire all adapters → gateway. Telegram and Slack adapters stamp
  // `InboundMessage.botKey` themselves (from the `botKey` field passed
  // at construction). Email and Discord don't stamp; their messages
  // fall back to `defaultBotKey` in single-bot deployments and are
  // dropped by the gateway with an observability event in multi-bot
  // ones (warned about at boot above).
  for (const adapter of adapters) {
    adapter.onMessage((message) => {
      void gateway.handleMessage(message, adapter).catch((err) => {
        console.error(`[gateway:${adapter.id}] Error:`, err);
      });
    });
  }
  // Wire the interactive tool-approval flow. Registers a `before_tool_call`
  // hook on every bot loop that suspends a dangerous tool call until the
  // user clicks Allow / Deny on an approval card (Slack or Telegram).
  // No-op for deployments without an approval-capable adapter.
  wireApprovalFlow(gateway, bots, adapters);
  // Start the cron scheduler that was hoisted above (so agent-callable
  // cron tools register against the same instance the firing engine
  // uses). At this point `systemLoop` is assigned, so the deferred
  // `runJob` closure can safely run.
  scheduler.start();
  console.log(`${c.dim}Cron scheduler running (checks every 60s)${c.reset}`);
  // Start all adapters
  await Promise.all(adapters.map((a) => a.start()));
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
  const healthServer = createHealthServer(healthPort, healthHost, async () => {
    const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
    const allOk = hb.adapters.length > 0 && hb.adapters.every((a) => a.ok);
    return {
      status: allOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      pid: hb.pid,
      startedAt: hb.startedAt,
      updatedAt: hb.updatedAt,
      adapters: hb.adapters,
    };
  });
  console.log(`  health: http://${healthHost}:${healthPort}/healthz`);
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
  // Graceful shutdown on SIGINT / SIGTERM. Tell every in-flight chat that the
  // gateway was interrupted so they don't sit waiting on a response that
  // never comes. See plan/IMPROVEMENT.md P1-1.
  const shutdown = async () => {
    console.log(`\n${c.dim}Shutting down...${c.reset}`);
    if (stopWatchdog) stopWatchdog();
    healthServer.close();
    clearInterval(pruneTimer);
    clearInterval(heartbeatTimer);
    scheduler.stop();
    await storage.remove(gatewayHealthPath()).catch(() => {});
    await gateway.shutdown({
      notify:
        '⚠ Ethos was interrupted while answering. Please resend your last message — your session history is preserved.',
    });
    await Promise.allSettled(adapters.map((a) => a.stop()));
    stopTeamSupervisors(bots, config.teams ?? {}, supervisorDeps);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Keep the process alive (adapter polling runs async)
  await new Promise(() => {});
}
/**
 * Derive the botKey for a WhatsApp config. MUST stay byte-identical to the
 * adapter's own fallback (`WhatsAppAdapter` in @ethosagent/platform-whatsapp)
 * so the key the gateway routes table is built from matches the key the
 * adapter stamps on inbound messages. WhatsApp has no token, so unlike
 * telegram/slack there is nothing to sha256 — the key is the explicit `id`
 * or a slug of the session directory.
 */
function whatsAppBotKey(waCfg) {
  return (
    waCfg.id ??
    `wa-${(waCfg.session_dir ?? join(ethosDir(), 'whatsapp')).replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`
  );
}
async function buildGatewayBots(config, scheduler) {
  const out = [];
  const setters = [];
  const buildOne = async (bot) => {
    const botKey = deriveBotKey(bot);
    let loop;
    if (bot.bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bot.bind.name);
      loop = team.loop;
    } else {
      // Per-bot personality loop. Threads the shared scheduler so
      // `create_cron_job` etc. lands in the same store as the
      // system-loop's jobs.
      const result = await createAgentLoop(
        { ...config, personality: bot.bind.name },
        { cronScheduler: scheduler },
      );
      loop = result.loop;
      setters.push(result.setMessagingSend);
    }
    return { botKey, loop, binding: { ...bot.bind } };
  };
  for (const bot of config.telegram?.bots ?? []) out.push(await buildOne(bot));
  for (const app of config.slack?.apps ?? []) out.push(await buildOne(app));
  for (const waCfg of config.whatsapp ?? []) {
    const botKey = whatsAppBotKey(waCfg);
    // WhatsApp bind is optional (unlike telegram/slack). A bind-less entry
    // falls back to the default personality — but make that visible so a
    // misconfigured bot doesn't silently answer as the wrong persona.
    const bind = waCfg.bind ?? { type: 'personality', name: config.personality };
    if (!waCfg.bind) {
      console.warn(
        `[whatsapp] bot "${botKey}" has no personality bind — using the default personality "${config.personality}". Re-save it in the app to bind a personality.`,
      );
    }
    let loop;
    if (bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bind.name);
      loop = team.loop;
    } else {
      const result = await createAgentLoop(
        { ...config, personality: bind.name },
        { cronScheduler: scheduler },
      );
      loop = result.loop;
      setters.push(result.setMessagingSend);
    }
    out.push({ botKey, loop, binding: { ...bind } });
  }
  return { bots: out, messagingSetters: setters };
}
/**
 * Runtime narrowing for the approval surface. The adapter list is typed as
 * `PlatformAdapter[]` (adapters are loaded lazily and heterogeneously), so a
 * structural probe is still needed to pick out the approval-capable ones —
 * but it narrows to the explicit, package-owned `ApprovalCapableAdapter`
 * type, not an ad-hoc shape.
 */
function isApprovalCapable(adapter) {
  const a = adapter;
  return (
    typeof a.botKey === 'string' &&
    typeof a.postApprovalCard === 'function' &&
    typeof a.updateApprovalCard === 'function' &&
    typeof a.onApprovalDecision === 'function'
  );
}
/**
 * Connect the agent loop's `before_tool_call` hook to approval cards.
 *
 * Three wires:
 *   1. `before_tool_call` hook on every approval-capable bot loop →
 *      `ApprovalCoordinator` suspends dangerous calls.
 *   2. `coordinator.onPending` → resolve the sessionId to its adapter/chat/
 *      thread via the gateway and post an approval card.
 *   3. each adapter's button-click event → `coordinator.approve/deny`
 *      and an in-place update of the card.
 *
 * Skipped entirely when no approval-capable adapter is configured.
 */
function wireApprovalFlow(gateway, bots, adapters) {
  const approvalAdapters = adapters.filter(isApprovalCapable);
  if (approvalAdapters.length === 0) return;
  const coordinator = new ApprovalCoordinator();
  const isDangerous = createDangerPredicate();
  // Where a posted card lives, keyed by `approvalId`. Populated once
  // `postApprovalCard` succeeds; consumed by the `onResolved` handler so the
  // card is updated in place no matter HOW the approval resolved — button
  // click, timeout, or session cancel. A fail-closed deny (no card ever
  // posted) simply has no entry here, so the update is skipped.
  const postedCards = new Map();
  // Resolutions that landed BEFORE the card finished posting (e.g. a session
  // cancel races the API call). Keyed by `approvalId`. The post
  // `.then()` drains this so a card posted into an already-resolved approval
  // is updated immediately instead of being left with live buttons forever.
  const resolvedBeforePost = new Map();
  // `approvalId`s with a `postApprovalCard` call genuinely in flight. Gates
  // `resolvedBeforePost`: without it, a fail-closed deny (no route / no
  // adapter / post failure) would record an outcome that no post
  // `.then()` ever drains — an unbounded leak.
  const inFlightPosts = new Set();
  // Resolve a `sessionId` to its approval target. Returns `undefined` for
  // any turn whose route isn't an approval-capable adapter.
  const resolveApprovalTarget = (sessionId) => {
    const route = gateway.resolveApprovalRoute(sessionId);
    if (!route || !isApprovalCapable(route.adapter)) return undefined;
    // Bind the approval to the user whose message triggered the turn, so a
    // bystander in the channel can't click Allow on a tool call they don't own.
    return { requesterUserId: route.requesterUserId };
  };
  // Register the approval hook only on loops whose bot has an
  // approval-capable adapter.
  const approvalBotKeys = new Set(approvalAdapters.map((a) => a.botKey));
  for (const bot of bots) {
    if (!approvalBotKeys.has(bot.botKey)) continue;
    bot.loop.hooks.registerModifying(
      'before_tool_call',
      createSlackApprovalHook({ coordinator, isDangerous, resolveApprovalTarget }),
    );
  }
  // Update a posted card to its resolved state. Shared by the normal
  // `onResolved` path and the post-races-resolution recovery path.
  const updateCard = (card, decision, decidedBy) => {
    void card.adapter
      .updateApprovalCard({
        chatId: card.chatId,
        messageTs: card.messageTs,
        toolName: card.toolName,
        decision,
        decidedBy,
      })
      .then((result) => {
        if (!result.ok) {
          console.error('[gateway] failed to update approval card:', result.error);
        }
      })
      .catch((err) => {
        console.error('[gateway] failed to update approval card:', err);
      });
  };
  // Pending approval → post a card on the originating Slack conversation.
  //
  // Fail CLOSED: the agent loop's hook is already suspended on the
  // coordinator promise. Any path that can't deliver a card — no route, a
  // non-Slack adapter (e.g. a Discord/Email message that fell back to this
  // Slack bot's loop), or a Slack post failure — must resolve the approval
  // as a deny, or the turn hangs forever with no way to recover. Card
  // delivery is a correctness path, not an observability-only one.
  coordinator.onPending((req) => {
    const route = gateway.resolveApprovalRoute(req.sessionId);
    if (!route || !isApprovalCapable(route.adapter)) {
      void coordinator.deny(req.approvalId, 'system');
      return;
    }
    const adapter = route.adapter;
    inFlightPosts.add(req.approvalId);
    void adapter
      .postApprovalCard({
        chatId: route.chatId,
        threadId: route.threadId,
        approvalId: req.approvalId,
        toolName: req.toolName,
        reason: req.reason,
        args: req.args,
      })
      .then((result) => {
        inFlightPosts.delete(req.approvalId);
        if ('error' in result) {
          console.error('[gateway] failed to post approval card:', result.error);
          resolvedBeforePost.delete(req.approvalId);
          void coordinator.deny(req.approvalId, 'system');
          return;
        }
        const card = {
          adapter,
          chatId: route.chatId,
          messageTs: result.messageTs,
          toolName: req.toolName,
        };
        // If the approval resolved while this post was in flight, the
        // `onResolved` handler already ran and found no card. Drain that
        // recorded outcome now so the freshly-posted card doesn't sit in the
        // channel with live buttons forever.
        const racedOutcome = resolvedBeforePost.get(req.approvalId);
        if (racedOutcome) {
          resolvedBeforePost.delete(req.approvalId);
          updateCard(card, racedOutcome.decision, racedOutcome.decidedBy);
          return;
        }
        postedCards.set(req.approvalId, card);
      })
      .catch((err) => {
        inFlightPosts.delete(req.approvalId);
        resolvedBeforePost.delete(req.approvalId);
        console.error('[gateway] failed to post approval card:', err);
        void coordinator.deny(req.approvalId, 'system');
      });
  });
  // Resolution (from ANY source — click, timeout, cancel) → update the card
  // in place so its buttons disappear and it reflects the real decision. The
  // card UI must never lie about approval state. When a card post is still
  // in flight, record the outcome so the post `.then()` can apply it the
  // moment the card exists; when no post is in flight (a fail-closed deny
  // with no route), there's no card to update and nothing to record.
  coordinator.onResolved((approvalId, decision, decidedBy) => {
    const card = postedCards.get(approvalId);
    if (!card) {
      if (inFlightPosts.has(approvalId)) {
        resolvedBeforePost.set(approvalId, { decision, decidedBy });
      }
      return;
    }
    postedCards.delete(approvalId);
    updateCard(card, decision, decidedBy);
  });
  // Button click → resolve the approval through the coordinator. The card
  // update is handled by the `onResolved` handler above, so a click and a
  // timeout converge on the same render path.
  for (const adapter of approvalAdapters) {
    adapter.onApprovalDecision((event) => {
      if (event.decision === 'allow') {
        void coordinator.approve(event.approvalId, event.decidedBy);
      } else {
        void coordinator.deny(event.approvalId, event.decidedBy);
      }
    });
  }
}
/**
 * Validate that every bot binding points at a real personality or team
 * on disk. Personality set comes from the same `FilePersonalityRegistry`
 * the agent loop uses at runtime — no duplicated roster of built-ins
 * to drift the next time built-ins change. Team set comes from
 * `~/.ethos/teams/<name>.yaml`.
 */
async function validateBindings(config) {
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
  const personalityIds = new Set(registry.list().map((p) => p.id));
  // Team manifests live at ~/.ethos/teams/<name>.yaml. Storage.listEntries
  // is the constitution-approved listing primitive and yields an empty
  // list for a missing directory, so no pre-check needed.
  const teamNames = new Set();
  for (const entry of await storage.listEntries(join(ethosDir(), 'teams'))) {
    if (entry.name.endsWith('.yaml')) teamNames.add(entry.name.replace(/\.yaml$/, ''));
  }
  return validateBotBindings(config, { personalityIds, teamNames });
}
/**
 * Adapt the personality-scoped MemoryProvider to the narrow
 * `{ read, append }` shape the Slack `/ethos memory` command consumes.
 * Scopes every read/write to `personality:<id>` so each Slack bot sees
 * the MEMORY.md of the personality it's bound to.
 */
function createSlackMemoryReader(personalityId) {
  const provider = createMemoryProvider({ dataDir: ethosDir() });
  const ctx = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: '',
    platform: 'slack',
    workingDir: process.cwd(),
  };
  return {
    async read() {
      const entry = await provider.read('MEMORY.md', ctx);
      return entry?.content ?? null;
    },
    async append(text) {
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: text }], ctx);
    },
  };
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
    trustedFirstPartySources: [bundledSkillsSource()],
  });
  return {
    async read(personalityId) {
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
/**
 * Build the Telegram `/personality rich` card reader. Mirrors the Slack
 * reader but renders the card as Telegram Markdown text via the Telegram
 * personality module. Lazily imports `@ethosagent/platform-telegram` so
 * the function stays safe when the Telegram adapter SDK isn't installed.
 */
async function createTelegramPersonalityCardReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  const { skillsInjector } = createInjectors(registry, {
    trustedFirstPartySources: [bundledSkillsSource()],
  });
  // Lazily import the Telegram personality renderer. The import type is
  // erased at runtime; the `as` cast is safe because we catch import failure.
  let renderFn = null;
  try {
    const mod = await import('@ethosagent/platform-telegram/personality');
    renderFn = mod.personalityRichMessage;
  } catch {
    // Telegram personality module not available — reader will return null.
  }
  return {
    async read(personalityId) {
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
async function createTelegramGreetingProvider() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  return {
    async greet(personalityId) {
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
export async function buildAdapters(config, loadAdapter, attachmentCache, opts) {
  config = applyPlatformShim(config).config;
  const adapters = [];
  if ((config.telegram?.bots.length ?? 0) > 0) {
    const mod = await loadAdapter('@ethosagent/platform-telegram', 'Telegram');
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
        let identity;
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
            dropPendingUpdates: true,
            ...(identity ? { identity } : {}),
          }),
        );
      }
    }
  }
  if ((config.slack?.apps.length ?? 0) > 0) {
    const mod = await loadAdapter('@ethosagent/platform-slack', 'Slack');
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
      for (const appCfg of config.slack?.apps ?? []) {
        // `/ethos memory show|add` reads the bound personality's MEMORY.md.
        // Team bindings have no single MEMORY.md, so they keep degrading to
        // "Memory is unavailable for this bot."
        const memory =
          appCfg.bind.type === 'personality'
            ? createSlackMemoryReader(appCfg.bind.name)
            : undefined;
        adapters.push(
          new mod.SlackAdapter({
            botToken: appCfg.botToken,
            appToken: appCfg.appToken,
            signingSecret: appCfg.signingSecret,
            botKey: deriveBotKey(appCfg),
            binding: { type: appCfg.bind.type, name: appCfg.bind.name },
            storage: slackStorage,
            personalityCard,
            ...(attachmentCache ? { cache: attachmentCache } : {}),
            ...(memory ? { memory } : {}),
          }),
        );
      }
    }
  }
  if (config.discordToken) {
    const mod = await loadAdapter('@ethosagent/platform-discord', 'Discord');
    if (mod) {
      adapters.push(new mod.DiscordAdapter({ token: config.discordToken }));
    }
  }
  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    const mod = await loadAdapter('@ethosagent/platform-email', 'Email');
    if (mod) {
      adapters.push(
        new mod.EmailAdapter({
          imapHost: config.emailImapHost,
          imapPort: config.emailImapPort ?? 993,
          user: config.emailUser,
          password: config.emailPassword,
          smtpHost: config.emailSmtpHost,
          smtpPort: config.emailSmtpPort ?? 587,
        }),
      );
    }
  }
  if ((config.whatsapp?.length ?? 0) > 0) {
    const mod = await loadAdapter('@ethosagent/platform-whatsapp', 'WhatsApp');
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
          throw new Error(
            `[whatsapp] Multiple WhatsApp configs require explicit 'id' fields. ${missingIds.length} config(s) are missing an id.`,
          );
        }
        const ids = waConfigs.map((c) => c.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length > 0) {
          throw new Error(
            `[whatsapp] Duplicate WhatsApp bot IDs: ${dupes.join(', ')}. Each config must have a unique id.`,
          );
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
            allowedJids: waCfg.allowed_numbers,
            cache: waCache,
            onQr: onQrCb ? (qr) => onQrCb(waCfg.id ?? 'default', qr) : undefined,
            ...(waCfg.phone_number ? { phoneNumber: waCfg.phone_number } : {}),
            onPairingCode: onPairingCb
              ? (code) => onPairingCb(waCfg.id ?? 'default', code)
              : undefined,
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
 * `bridge.setPresenter`, `bridge.onResolved`, and `adapter.onCallbackQuery`
 * in its constructor; the gateway later calls `surface.correlateMessage` for
 * every inbound message.
 *
 * `getSessionRouting` resolves a sessionId to the chat + originator user id
 * of the turn that issued the clarify. Closes over a gateway reference that
 * is filled in *after* this function returns (the surface and the Gateway
 * each need a reference to the other), so callers must pass a closure rather
 * than a direct gateway method.
 */
async function buildTelegramClarifySurfaces(bots, adapters, getSessionRouting) {
  const telegramAdapters = adapters.filter((a) => a.id.startsWith('telegram:'));
  if (telegramAdapters.length === 0) return [];
  const mod = await loadAdapterModule(
    '@ethosagent/platform-telegram/clarify-surface',
    'Telegram clarify surface',
  );
  if (!mod) return [];
  const surfaces = [];
  for (const adapter of telegramAdapters) {
    // `adapter.id` is `telegram:<botKey>` — strip the prefix to find the
    // matching bot's clarifyBridge.
    const botKey = adapter.id.slice('telegram:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    // The TelegramAdapter satisfies TelegramClarifyAdapter structurally —
    // the methods were added in the same package.
    const tgAdapter = adapter;
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
 * without clarify support. Each surface registers `bridge.setPresenter`,
 * `bridge.onResolved`, `adapter.onClarifyAction`, and
 * `adapter.onClarifyModalSubmit` in its constructor; nothing else needs
 * wiring (Slack carries its own button-click + modal-submission events
 * through Bolt, so there's no inbound-correlator step like Telegram has
 * for force-replies).
 */
async function buildSlackClarifySurfaces(bots, adapters, getSessionRouting) {
  const slackAdapters = adapters.filter((a) => a.id.startsWith('slack:'));
  if (slackAdapters.length === 0) return [];
  const mod = await loadAdapterModule(
    '@ethosagent/platform-slack/clarify-surface',
    'Slack clarify surface',
  );
  if (!mod) return [];
  const surfaces = [];
  for (const adapter of slackAdapters) {
    const botKey = adapter.id.slice('slack:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    const slackAdapter = adapter;
    const surface = new mod.SlackClarifySurface({
      adapter: slackAdapter,
      bridge,
      store: bridge.store,
      getSessionRouting,
    });
    // Wire the App Home "Waiting on you" data source. Setter must run
    // before adapter.start() so registerHomeEvents picks it up.
    const withReader = adapter;
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
async function buildDiscordClarifySurfaces(bots, adapters, systemLoop, getSessionRouting) {
  const discordAdapters = adapters.filter((a) => a.id.startsWith('discord:'));
  if (discordAdapters.length === 0) return [];
  const mod = await loadAdapterModule(
    '@ethosagent/platform-discord/clarify-surface',
    'Discord clarify surface',
  );
  if (!mod) return [];
  const surfaces = [];
  for (const adapter of discordAdapters) {
    const botKey = adapter.id.slice('discord:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    // Per-bot loop wins; legacy single-Discord (no entry in `bots[]`) falls
    // back to the system loop. Either way, the bridge must exist — the
    // wiring layer always attaches one, so an absent bridge is a bug.
    const bridge = bot?.loop.clarifyBridge ?? systemLoop.clarifyBridge;
    if (!bridge) continue;
    const discordAdapter = adapter;
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
