import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentLoop } from '@ethosagent/core';
import { CronScheduler } from '@ethosagent/cron';
import { Gateway, type GatewayBotConfig } from '@ethosagent/gateway';
import { ConsoleLogger } from '@ethosagent/logger';
import { createPersonalityRegistry, firstParagraph } from '@ethosagent/personalities';
import { createInjectors } from '@ethosagent/skills';
import { bundledCodingSkillsSource } from '@ethosagent/skills-coding';
import { readRuntime, removeRuntime } from '@ethosagent/team-supervisor';
// Platform adapters are loaded LAZILY in runGatewayStart() — see plan/IMPROVEMENT.md P0-3.
// Their underlying SDKs (grammy, discord.js, @slack/bolt, imapflow…) are
// optionalDependencies of @ethosagent/cli. A failed install for any one of
// them must not crash the CLI for users who don't run that platform.
import type {
  ClarifyResponse,
  InboundMessage,
  MemoryContext,
  PlatformAdapter,
} from '@ethosagent/types';
import { createDangerPredicate, createMemoryProvider } from '@ethosagent/wiring';
import { ApprovalCoordinator, createSlackApprovalHook } from '../approval-coordinator';
import {
  applyPlatformShim,
  deriveBotKey,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  type SlackAppConfig,
  type TelegramBotConfig,
  validateBotBindings,
  writeConfig,
} from '../config';
import { migrateSessionKeysIfNeeded } from '../migrations/session-keys-multi-bot';
import { createAgentLoop, createTeamAgentLoop, getSecretsResolver, getStorage } from '../wiring';
import {
  ensureTeamSupervisors,
  stopTeamSupervisors,
  type TeamSupervisorDeps,
} from './supervisor-lifecycle';
import { isPidAlive } from './team-runtime';

// Best-effort dynamic import. Returns null and logs a clear warning if the
// module can't be loaded — typically because its underlying SDK isn't
// installed. Callers downgrade gracefully.
async function loadAdapterModule<T>(modulePath: string, label: string): Promise<T | null> {
  try {
    return (await import(modulePath)) as T;
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

  await writeConfig(storage, { ...config, telegramToken: token });
  console.log(`${c.green}✓ Token saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos gateway start${c.reset}${c.dim} to start the bot.${c.reset}\n`,
  );
}

// ---------------------------------------------------------------------------
// ethos gateway start
// ---------------------------------------------------------------------------

export async function runGatewayStart(): Promise<void> {
  // Load config through the strict path so parse-time errors (typos in
  // bind.type, missing bot tokens) surface here instead of silently
  // booting zero bots. The strict loader also applies the legacy →
  // list-shape shim and returns the deprecation messages we should
  // surface before any other work.
  const storage = getStorage();
  const loaded = await loadConfigStrict(storage, getSecretsResolver());
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

  const hasEmailConfig =
    config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost;

  const hasAnyPlatform =
    config.telegramToken ||
    config.discordToken ||
    (config.slackBotToken && config.slackAppToken && config.slackSigningSecret) ||
    (config.telegram?.bots.length ?? 0) > 0 ||
    (config.slack?.apps.length ?? 0) > 0 ||
    hasEmailConfig;

  if (!hasAnyPlatform) {
    console.log(`${c.red}No platform configured. Run: ethos gateway setup${c.reset}`);
    process.exit(1);
  }

  // Multi-bot routing has a known limitation in v1: email and discord
  // continue to use a single legacy adapter without botKey stamping.
  // When multi-bot telegram/slack is configured alongside email/discord,
  // those legacy adapters' messages have no botKey, and the Gateway has
  // no `defaultBotKey` to fall back on (defaultBotKey only fires for
  // single-bot deployments). Warn at boot so operators know.
  const multiBotConfigured =
    (config.telegram?.bots.length ?? 0) + (config.slack?.apps.length ?? 0) > 1;
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

  // Build one AgentLoop per configured bot. Personality bots use
  // `createAgentLoop`; team bots use `createTeamAgentLoop`.
  const bots = await buildGatewayBots(config);

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
  // System loop used by cron — not bot-bound. Cron jobs route through
  // their own `job.personality` field, not through the platform bot
  // routing table.
  const systemLoop = await createAgentLoop(config);

  // Build and register all configured adapters early so we can wire the
  // clarify surfaces *before* constructing the Gateway. The surfaces' combined
  // `correlateMessage` is passed in as `clarifyMessageCorrelator`. The
  // surface's `getSessionRouting` closes over a mutable holder filled in
  // right after Gateway construction — necessary because the surface and the
  // Gateway each need a reference to the other.
  const adapters = await buildAdapters(config, loadAdapterModule);

  let gatewayRef: Gateway | null = null;
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
      ? async (msg: InboundMessage): Promise<ClarifyResponse | null> => {
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

  const gateway: Gateway =
    bots.length === 0
      ? // Email-only deployment (no telegram/slack bots configured). Keep
        // the legacy single-loop construction for the email path.
        new Gateway({ loop: systemLoop, defaultPersonality: config.personality })
      : new Gateway({
          bots,
          ...(clarifyMessageCorrelator ? { clarifyMessageCorrelator } : {}),
          ...(telegramCardReader ? { personalityCardReader: telegramCardReader } : {}),
          ...(telegramGreetingProvider ? { greetingProvider: telegramGreetingProvider } : {}),
        });
  gatewayRef = gateway;

  // Index bots by botKey so health-check lines can show the binding inline.
  const botByKey = new Map(bots.map((b) => [b.botKey, b]));

  if (adapters.length === 0) {
    console.log(
      `${c.red}No adapters could be started. Either no platform is configured, or every configured platform's SDK failed to load.${c.reset}`,
    );
    process.exit(1);
  }

  // Wire all adapters → gateway. Telegram and Slack adapters stamp
  // `InboundMessage.botKey` themselves (from the `botKey` field passed
  // at construction). Email and Discord don't stamp; their messages
  // fall back to `defaultBotKey` in single-bot deployments and are
  // dropped by the gateway with an observability event in multi-bot
  // ones (warned about at boot above).
  for (const adapter of adapters) {
    adapter.onMessage((message: InboundMessage) => {
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

  // Start cron scheduler — runs inside the gateway process
  const scheduler = new CronScheduler({
    logger: new ConsoleLogger(),
    runJob: async (job) => {
      const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
      let output = '';
      for await (const event of systemLoop.run(job.prompt, {
        sessionKey,
        personalityId: job.personality ?? config.personality,
      })) {
        if (event.type === 'text_delta') output += event.text;
      }
      return { jobId: job.id, ranAt: new Date().toISOString(), output, sessionKey };
    },
  });
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

  console.log(`${c.dim}Listening for messages. Press Ctrl+C to stop.${c.reset}\n`);

  // Graceful shutdown on SIGINT / SIGTERM. Tell every in-flight chat that the
  // gateway was interrupted so they don't sit waiting on a response that
  // never comes. See plan/IMPROVEMENT.md P1-1.
  const shutdown = async () => {
    console.log(`\n${c.dim}Shutting down...${c.reset}`);
    scheduler.stop();
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

// ---------------------------------------------------------------------------
// Phase 1 helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-bot routing table the Gateway needs. Walks both
 * `config.telegram.bots` and `config.slack.apps`, resolving each
 * binding to either a personality-scoped AgentLoop (`createAgentLoop`)
 * or a team coordinator loop (`createTeamAgentLoop`). The botKey
 * matches what adapters will stamp on inbound messages.
 */
async function buildGatewayBots(config: EthosConfig): Promise<GatewayBotConfig[]> {
  const out: GatewayBotConfig[] = [];
  const buildOne = async (bot: TelegramBotConfig | SlackAppConfig): Promise<GatewayBotConfig> => {
    const botKey = deriveBotKey(bot);
    let loop: AgentLoop;
    if (bot.bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bot.bind.name);
      loop = team.loop;
    } else {
      loop = await createAgentLoop({ ...config, personality: bot.bind.name });
    }
    return { botKey, loop, binding: { ...bot.bind } };
  };
  for (const bot of config.telegram?.bots ?? []) out.push(await buildOne(bot));
  for (const app of config.slack?.apps ?? []) out.push(await buildOne(app));
  return out;
}

// ---------------------------------------------------------------------------
// Interactive tool-approval flow (Slack, Telegram, any ApprovalCapableAdapter)
// ---------------------------------------------------------------------------

// `import type` only — erased at runtime, so `@ethosagent/platform-slack`
// stays lazily loaded via `loadAdapterModule` and the layering is unchanged.
// The approval contract lives in `@ethosagent/types` so any adapter
// (Slack, Telegram, future) can implement it without cross-platform imports.
type ApprovalCapableAdapter = import('@ethosagent/types').ApprovalCapableAdapter;

/**
 * Runtime narrowing for the approval surface. The adapter list is typed as
 * `PlatformAdapter[]` (adapters are loaded lazily and heterogeneously), so a
 * structural probe is still needed to pick out the approval-capable ones —
 * but it narrows to the explicit, package-owned `ApprovalCapableAdapter`
 * type, not an ad-hoc shape.
 */
function isApprovalCapable(
  adapter: PlatformAdapter,
): adapter is PlatformAdapter & ApprovalCapableAdapter {
  const a = adapter as Partial<ApprovalCapableAdapter>;
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
function wireApprovalFlow(
  gateway: Gateway,
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
): void {
  const approvalAdapters = adapters.filter(isApprovalCapable);
  if (approvalAdapters.length === 0) return;

  const coordinator = new ApprovalCoordinator();
  const isDangerous = createDangerPredicate();

  // Where a posted card lives, keyed by `approvalId`. Populated once
  // `postApprovalCard` succeeds; consumed by the `onResolved` handler so the
  // card is updated in place no matter HOW the approval resolved — button
  // click, timeout, or session cancel. A fail-closed deny (no card ever
  // posted) simply has no entry here, so the update is skipped.
  const postedCards = new Map<
    string,
    { adapter: ApprovalCapableAdapter; chatId: string; messageTs: string; toolName: string }
  >();
  // Resolutions that landed BEFORE the card finished posting (e.g. a session
  // cancel races the API call). Keyed by `approvalId`. The post
  // `.then()` drains this so a card posted into an already-resolved approval
  // is updated immediately instead of being left with live buttons forever.
  const resolvedBeforePost = new Map<string, { decision: 'allow' | 'deny'; decidedBy: string }>();
  // `approvalId`s with a `postApprovalCard` call genuinely in flight. Gates
  // `resolvedBeforePost`: without it, a fail-closed deny (no route / no
  // adapter / post failure) would record an outcome that no post
  // `.then()` ever drains — an unbounded leak.
  const inFlightPosts = new Set<string>();

  // Resolve a `sessionId` to its approval target. Returns `undefined` for
  // any turn whose route isn't an approval-capable adapter.
  const resolveApprovalTarget = (sessionId: string) => {
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
  const updateCard = (
    card: { adapter: ApprovalCapableAdapter; chatId: string; messageTs: string; toolName: string },
    decision: 'allow' | 'deny',
    decidedBy: string,
  ): void => {
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
async function validateBindings(config: EthosConfig): Promise<string[]> {
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
export type AdapterModuleLoader = <T>(modulePath: string, label: string) => Promise<T | null>;

/**
 * Adapt the personality-scoped MemoryProvider to the narrow
 * `{ read, append }` shape the Slack `/ethos memory` command consumes.
 * Scopes every read/write to `personality:<id>` so each Slack bot sees
 * the MEMORY.md of the personality it's bound to.
 */
function createSlackMemoryReader(personalityId: string) {
  const provider = createMemoryProvider({ dataDir: ethosDir() });
  const ctx: MemoryContext = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: '',
    platform: 'slack',
    workingDir: process.cwd(),
  };
  return {
    async read(): Promise<string | null> {
      const entry = await provider.read('MEMORY.md', ctx);
      return entry?.content ?? null;
    },
    async append(text: string): Promise<void> {
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: text }], ctx);
    },
  };
}

/**
 * Build the `/ethos personality rich` card reader: the personality registry
 * supplies config + ETHOS.md, and the shared `SkillsInjector.resolveSkills()`
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
    trustedFirstPartySources: [bundledCodingSkillsSource()],
  });
  return {
    async read(personalityId: string) {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) return null;
      const ethosMd = await registry.readEthosMd(personalityId);
      const resolved = await skillsInjector.resolveSkills(personalityId);
      return {
        id: config.id,
        name: config.name,
        description: config.description ?? '',
        prose: firstParagraph(ethosMd),
        model: config.model ?? '(engine default)',
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
    trustedFirstPartySources: [bundledCodingSkillsSource()],
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
      const ethosMd = await registry.readEthosMd(personalityId);
      const resolved = await skillsInjector.resolveSkills(personalityId);
      const card = {
        id: config.id,
        name: config.name,
        description: config.description ?? '',
        prose: firstParagraph(ethosMd),
        model: config.model ?? '(engine default)',
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
 * ETHOS.md), plus a pointer to `/help`.
 */
async function createTelegramGreetingProvider() {
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
      const ethosMd = await registry.readEthosMd(personalityId).catch(() => '');
      const prose = firstParagraph(ethosMd);
      const intro = prose || config.description || config.name;
      return `${intro}\n\nUse /help to see available commands.`;
    },
  };
}

export async function buildAdapters(
  config: EthosConfig,
  loadAdapter: AdapterModuleLoader,
): Promise<PlatformAdapter[]> {
  config = applyPlatformShim(config).config;
  const adapters: PlatformAdapter[] = [];

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

      // Shared attachment cache for all Telegram bots.
      const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
      const cache = new FsAttachmentCache(storage, join(ethosDir(), 'cache', 'attachments'));

      for (const botCfg of config.telegram?.bots ?? []) {
        let identity: { name: string; shortDescription: string; description: string } | undefined;
        if (botCfg.bind.type === 'personality') {
          const pConfig = registry.get(botCfg.bind.name);
          if (pConfig) {
            const ethosMd = await registry.readEthosMd(botCfg.bind.name).catch(() => '');
            const prose = firstParagraph(ethosMd);
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
            cache,
            botKey: deriveBotKey(botCfg),
            dropPendingUpdates: true,
            ...(identity ? { identity } : {}),
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
            ...(memory ? { memory } : {}),
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
      adapters.push(new mod.DiscordAdapter({ token: config.discordToken }));
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
        }),
      );
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
 * without clarify support. Each surface registers `bridge.setPresenter`,
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
