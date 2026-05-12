import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentLoop } from '@ethosagent/core';
import { CronScheduler } from '@ethosagent/cron';
import { Gateway, type GatewayBotConfig } from '@ethosagent/gateway';
import { ConsoleLogger } from '@ethosagent/logger';
import { createPersonalityRegistry } from '@ethosagent/personalities';
// Platform adapters are loaded LAZILY in runGatewayStart() — see plan/IMPROVEMENT.md P0-3.
// Their underlying SDKs (grammy, discord.js, @slack/bolt, imapflow…) are
// optionalDependencies of @ethosagent/cli. A failed install for any one of
// them must not crash the CLI for users who don't run that platform.
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import {
  applyPlatformShim,
  deriveBotKey,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readConfig,
  type SlackAppConfig,
  type TelegramBotConfig,
  validateBotBindings,
  writeConfig,
} from '../config';
import { migrateSessionKeysIfNeeded } from '../migrations/session-keys-multi-bot';
import { createAgentLoop, createTeamAgentLoop, getStorage } from '../wiring';

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
  const config = await readConfig(storage);
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
  const loaded = await loadConfigStrict(storage);
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

  // Build one AgentLoop per configured bot. Personality bots get the
  // shared `createAgentLoop`; team bots get `createTeamAgentLoop` (the
  // supervisor lifecycle wiring lands in Phase 3).
  const bots = await buildGatewayBots(config);
  // System loop used by cron — not bot-bound. Cron jobs route through
  // their own `job.personality` field, not through the platform bot
  // routing table.
  const systemLoop = await createAgentLoop(config);
  const gateway: Gateway =
    bots.length === 0
      ? // Email-only deployment (no telegram/slack bots configured). Keep
        // the legacy single-loop construction for the email path.
        new Gateway({ loop: systemLoop, defaultPersonality: config.personality })
      : new Gateway({ bots });
  for (const bot of bots) {
    console.log(
      `${c.dim}bot${c.reset} ${c.bold}${bot.botKey}${c.reset} ${c.dim}→ ${bot.binding.type}:${bot.binding.name}${c.reset}`,
    );
  }
  // Build and register all configured adapters. Each loads lazily so a missing
  // SDK in node_modules only takes down its own platform, not the gateway.
  const adapters = await buildAdapters(config, loadAdapterModule);

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

  // Health checks
  for (const adapter of adapters) {
    const health = await adapter.health();
    if (health.ok) {
      const ms = health.latencyMs ? ` (${health.latencyMs}ms)` : '';
      console.log(`${c.green}✓ ${adapter.displayName} online${c.reset}${c.dim}${ms}${c.reset}`);
    } else {
      console.log(`${c.yellow}⚠ ${adapter.displayName} health check failed${c.reset}`);
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
      for (const botCfg of config.telegram?.bots ?? []) {
        adapters.push(
          new mod.TelegramAdapter({
            token: botCfg.token,
            botKey: deriveBotKey(botCfg),
            dropPendingUpdates: true,
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
      for (const appCfg of config.slack?.apps ?? []) {
        adapters.push(
          new mod.SlackAdapter({
            botToken: appCfg.botToken,
            appToken: appCfg.appToken,
            signingSecret: appCfg.signingSecret,
            botKey: deriveBotKey(appCfg),
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
