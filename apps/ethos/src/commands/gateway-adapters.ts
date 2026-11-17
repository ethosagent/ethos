// `ethos gateway start` — platform webhook mounts, the email sender-auth
// warning, and adapter start isolation: one failed adapter does not stop the
// others, a transient failure is retried with backoff, and the exit code for
// "every adapter failed" is derived here. Split out of gateway.ts, which
// re-exports everything public. `buildAdapters` and `loadAdapterModule` stay in
// gateway.ts: archcheck pins their `@ethosagent/personalities`, `storage-fs`
// and `platform-*` imports to that file's path.

import { applyPlatformShim, deriveBotKey, type EthosConfig } from '@ethosagent/config';
import type { Gateway, GatewayObservability } from '@ethosagent/gateway';
import type { PlatformAdapter } from '@ethosagent/types';
import { CONFIG_INVALID_EXIT_CODE } from '@ethosagent/wiring';
import type { PlatformWebhookHandler } from '../platform-webhook-server';
import { getEthosObservability } from '../wiring';
import { c } from './_shared';

/**
 * The two adapters that can serve a platform webhook, viewed structurally.
 *
 * Neither getter is on `PlatformAdapter` — webhook hosting is a property of
 * two specific adapters, not of the channel contract — and both are optional
 * because both are `undefined` in the transport mode this repo has always
 * defaulted to (Telegram long-poll, Slack Socket Mode).
 */
interface WebhookCapableAdapter {
  /** `TelegramAdapter.webhook` — grammy's `'http'` framework callback. */
  readonly webhook?: PlatformWebhookHandler | undefined;
  /** `SlackAdapter.requestListener` — Bolt's `HTTPReceiver`. */
  readonly requestListener?: PlatformWebhookHandler | undefined;
  /** `SlackAdapter.webhookRoute` — the path that receiver answers on. */
  readonly webhookRoute?: string | undefined;
}

/** Dispatch maps for `createPlatformWebhookServer`. Empty = nothing to host. */
export interface PlatformWebhookMounts {
  /** botKey → handler, mounted at `/telegram/webhook/<botKey>`. */
  telegram: Map<string, PlatformWebhookHandler>;
  /** Full route path → handler, as the Slack adapter reports it. */
  slack: Map<string, PlatformWebhookHandler>;
}

/**
 * Collect the webhook handlers of every bot/app the operator put in webhook
 * mode (plan/phases/telegram-slack-webhook-mode.md §2b, §3c).
 *
 * MUST be called AFTER `adapter.start()`. `TelegramAdapter.webhook` is
 * `undefined` until `start()` builds the grammy callback, so calling this at
 * construction time would find nothing to mount and silently fall back to a
 * server that 404s every delivery.
 *
 * Slack is keyed by `adapter.webhookRoute` rather than by a locally recomputed
 * `/slack/events/<botKey>`: Bolt's `HTTPReceiver` matches its `endpoints` list
 * EXACTLY, so a mount path derived twice is a mount path that can drift, and
 * the drift shows up as a production 404 rather than a type error.
 */
export function buildPlatformWebhookMounts(
  config: EthosConfig,
  adapters: PlatformAdapter[],
  warn: (message: string) => void,
): PlatformWebhookMounts {
  // Idempotent — same defensive call `buildAdapters` makes, so a legacy
  // single-bot config resolves to the same botKeys the adapters were built on.
  const shimmed = applyPlatformShim(config).config;
  const byId = new Map(adapters.map((a) => [a.id, a as PlatformAdapter & WebhookCapableAdapter]));
  const telegram = new Map<string, PlatformWebhookHandler>();
  const slack = new Map<string, PlatformWebhookHandler>();

  for (const botCfg of shimmed.telegram?.bots ?? []) {
    if (!botCfg.useWebhook) continue;
    const botKey = deriveBotKey(botCfg);
    const handler = byId.get(`telegram:${botKey}`)?.webhook;
    if (!handler) {
      warn(
        `telegram bot "${botKey}" is configured with use_webhook but its adapter exposes ` +
          'no webhook handler — no route was mounted and Telegram deliveries will 404.',
      );
      continue;
    }
    telegram.set(botKey, handler);
  }

  for (const appCfg of shimmed.slack?.apps ?? []) {
    if (!appCfg.mode?.http) continue;
    const botKey = deriveBotKey(appCfg);
    const adapter = byId.get(`slack:${botKey}`);
    const handler = adapter?.requestListener;
    const route = adapter?.webhookRoute;
    if (!handler || !route) {
      warn(
        `slack app "${botKey}" is configured with mode.http but its adapter exposes no ` +
          'request listener — no route was mounted and Slack deliveries will 404.',
      );
      continue;
    }
    slack.set(route, handler);
  }

  return { telegram, slack };
}

/**
 * Boot-time notice for an email bot with no `emailTrustedAuthservId` (plan
 * openclaw-advisory-fixes Item 6). Without it `resolveEmailSender`
 * (extensions/platform-email/src/index.ts) treats EVERY sender as unverified,
 * so a deployment that upgraded without setting the key has lost identity
 * continuity for all of its correspondents — worth one warn-level event and
 * one console line, not a refusal to start (fail closed is the safe state).
 *
 * The configured-email predicate is the one `buildAdapters` uses. Called by
 * both adapter-owning hosts (`runGatewayStart`, `ethos boot`) right after
 * adapters are built. Fail-open on the record, like `gatewayObservability`.
 * Returns whether it warned. Pinned by
 * `__tests__/email-sender-auth-wiring.test.ts`.
 */
export function warnEmailSenderAuthUnconfigured(
  config: EthosConfig,
  record: (opts: { code: string; cause: string; severity: 'warn' }) => void = (opts) =>
    getEthosObservability().recordError(opts),
  log: (line: string) => void = (line) => console.log(line),
): boolean {
  const emailConfigured =
    config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost;
  if (!emailConfigured || config.emailTrustedAuthservId?.trim()) return false;
  const cause =
    'email is configured without emailTrustedAuthservId — every sender is treated as unverified (no From: address is trusted as an identity)';
  try {
    record({ code: 'email.sender_auth_unconfigured', cause, severity: 'warn' });
  } catch {
    // Fail-open — observability never stops the gateway starting.
  }
  log(
    `${c.yellow}⚠ ${cause}.${c.reset} ${c.dim}Set emailTrustedAuthservId to the first token of the Authentication-Results header on any mail this account received.${c.reset}`,
  );
  return true;
}

/**
 * Every adapter this process started, each exactly once — what a host's
 * shutdown `stop()`s. The host's own list (`buildGatewayAdapters`) holds only
 * the built-in adapters; the Gateway holds the rest live: the plugin-registered
 * ones (`GatewayConfig.pluginAdapters`, constructed AND started inside the
 * `Gateway` constructor, so no host list ever saw them) and any a live reload
 * added (`Gateway.addAdapter`). A bot a reload retired is gone from
 * `listAdapters()` and was already stopped by `Gateway.removeAdapter`, so it is
 * left out even though a built-in one is still in the host's list
 * (`Gateway.hasStopped`). An adapter in both lists appears once (identity).
 * Used by `ethos gateway start` and `ethos boot`; pinned by
 * apps/ethos/src/__tests__/every-started-adapter.test.ts.
 */
export function everyStartedAdapter(
  builtIn: readonly PlatformAdapter[],
  gateway: Pick<Gateway, 'listAdapters' | 'hasStopped'>,
): PlatformAdapter[] {
  return [...new Set([...builtIn, ...gateway.listAdapters()])].filter(
    (a) => !gateway.hasStopped(a),
  );
}

/**
 * `startAdaptersIsolated`'s `allFailed` for `ethos gateway start`. Its adapter
 * list is `buildGatewayAdapters`' built-ins only; a plugin-registered channel
 * (`GatewayConfig.pluginAdapters`) is constructed and started inside the
 * `Gateway` constructor and never appears in it. When the gateway serves such
 * an adapter it has something to serve, so an all-failed built-in start
 * continues — refused credentials abandoned, transient failures retried —
 * instead of exiting 78 over a dead token while the plugin channel is live.
 * With no adapter beyond the built-ins it throws, as before (V2-RT-5). Pinned
 * by `__tests__/gateway-adapter-start.test.ts` and, end to end, by
 * `__tests__/integration/gateway-sigkill-spool.integration.test.ts` (a fake
 * Telegram token beside a plugin channel).
 */
export function gatewayAllFailedPolicy(
  builtIn: readonly PlatformAdapter[],
  gateway: Pick<Gateway, 'listAdapters'>,
): 'throw' | 'continue' {
  const own = new Set(builtIn);
  return gateway.listAdapters().some((a) => !own.has(a)) ? 'continue' : 'throw';
}

/** First background retry of a failed adapter start (V-CC-4). */
export const ADAPTER_START_RETRY_BASE_MS = 5_000;

/** Cap on the gap between two retries of a failed adapter start. */
export const ADAPTER_START_RETRY_MAX_MS = 5 * 60_000;

/**
 * Delay before retry `attempt` (1-based) of a failed adapter start: 5s doubling
 * to a 5min cap, ±20% jitter so several bots that failed on one network blip do
 * not retry in lockstep. `random` is `Math.random`-shaped.
 */
export function adapterStartRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    ADAPTER_START_RETRY_MAX_MS,
    ADAPTER_START_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(base * (0.8 + 0.4 * random()));
}

/**
 * Whether an adapter `start()` rejection is a credential the platform refused —
 * a revoked or invalid token — which no retry can fix. The adapter's own
 * verdict wins: Discord, Telegram and Slack classify their start failures and
 * throw an error carrying a boolean `permanent` (`classifyDiscordStartError`,
 * `telegramTokenRejected`, `classifySlackStartError`; pinned by each adapter's
 * `start-permanent-error.test.ts`), and a boolean `permanent` is returned
 * as-is. Only an error without one — an adapter that does not classify, or a
 * failure it did not recognise — falls back to the SDK shapes: discord.js
 * `code: 'TokenInvalid'` / "An invalid token was provided"; grammy's Bot API
 * `error_code: 401` / "401: Unauthorized"; Slack Web API `invalid_auth`,
 * `not_authed`, `token_revoked`, `account_inactive`. Anything else — DNS, a
 * reset socket, a 5xx — is transient.
 */
export function isPermanentAdapterStartError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    if ('permanent' in err && typeof err.permanent === 'boolean') return err.permanent;
    if ('code' in err && err.code === 'TokenInvalid') return true;
    if ('error_code' in err && err.error_code === 401) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /invalid token|TokenInvalid|\b401\b|unauthorized|invalid_auth|not_authed|token_revoked|account_inactive/i.test(
    message,
  );
}

/** Background retry of a failed adapter start — see `startAdaptersIsolated`. */
export interface AdapterStartRetryOptions<A extends AdapterStartable = AdapterStartable> {
  /** Aborted by the host's shutdown; no attempt starts after it. */
  signal: AbortSignal;
  /** Called once an adapter starts on a retry (the host mounts its webhook). */
  onStarted?: (adapter: A) => void;
  /** An adapter a live config reload has retired (`Gateway.hasStopped`) is not
   *  retried, and is stopped again if a retry started it. */
  isRetired?: (adapter: A) => boolean;
  /** Tests. Default `Math.random`. */
  random?: () => number;
  /** Tests. Resolves `false` when `signal` aborted during the wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
}

type AdapterStartable = { id: string; start(): Promise<void>; stop?(): Promise<void> };

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry one failed adapter start until it starts, fails permanently
 * (`isPermanentAdapterStartError`) or `retry.signal` aborts. Every attempt is
 * warned about and recorded: `gateway.adapter_start_retry_failed` per failed
 * retry, `gateway.adapter_start_recovered` on success,
 * `gateway.adapter_start_abandoned` on a permanent failure. An adapter whose
 * start resolves after shutdown began is stopped again.
 */
async function retryAdapterStart<A extends AdapterStartable>(
  adapter: A,
  firstError: unknown,
  deps: {
    observability: Pick<GatewayObservability, 'recordSafetyBlock'>;
    warn: (message: string) => void;
  },
  retry: AdapterStartRetryOptions<A>,
): Promise<void> {
  const sleep = retry.sleep ?? abortableSleep;
  const abandon = (error: string, attempt: number) => {
    deps.warn(
      `adapter ${adapter.id} failed permanently (${error}) — not retrying; fix its credentials and restart the gateway`,
    );
    deps.observability.recordSafetyBlock({
      code: 'gateway.adapter_start_abandoned',
      cause: error,
      details: { adapterId: adapter.id, attempt },
    });
  };
  if (isPermanentAdapterStartError(firstError)) {
    abandon(firstError instanceof Error ? firstError.message : String(firstError), 0);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const delayMs = adapterStartRetryDelayMs(attempt, retry.random);
    if (!(await sleep(delayMs, retry.signal)) || retry.signal.aborted) return;
    if (retry.isRetired?.(adapter)) return;
    try {
      await adapter.start();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (isPermanentAdapterStartError(err)) {
        abandon(error, attempt);
        return;
      }
      deps.warn(`adapter ${adapter.id} retry ${attempt} failed: ${error} — retrying with backoff`);
      deps.observability.recordSafetyBlock({
        code: 'gateway.adapter_start_retry_failed',
        cause: error,
        details: { adapterId: adapter.id, attempt, delayMs },
      });
      continue;
    }
    if (retry.signal.aborted || retry.isRetired?.(adapter)) {
      await adapter.stop?.().catch(() => {});
      return;
    }
    deps.warn(`adapter ${adapter.id} started on retry ${attempt}`);
    deps.observability.recordSafetyBlock({
      code: 'gateway.adapter_start_recovered',
      cause: `started on retry ${attempt}`,
      details: { adapterId: adapter.id, attempt },
    });
    retry.onStarted?.(adapter);
    return;
  }
}

/**
 * `startAdaptersIsolated` rejected because EVERY adapter failed to start. The
 * message is the first failure's; `permanent` is whether every failure was a
 * credential the platform refused (`isPermanentAdapterStartError`).
 */
export class AllAdaptersFailedError extends Error {
  readonly permanent: boolean;
  constructor(first: unknown, permanent: boolean) {
    super(first instanceof Error ? first.message : String(first), { cause: first });
    this.name = 'AllAdaptersFailedError';
    this.permanent = permanent;
  }
}

/**
 * The exit code `ethos gateway start` uses for an adapter-start failure, or
 * undefined for "not a refusal — exit 1 like any crash". Every adapter refused
 * its credentials (V2-RT-5) → `CONFIG_INVALID_EXIT_CODE` (78, EX_CONFIG): the
 * tokens live in config and no restart can fix them, and 78 is already final
 * for `ethos run-all` (`defaultChildSpecs` terminalExitCodes), the systemd unit
 * (`RestartPreventExitStatus`), the launchd wrapper and the Windows supervisor,
 * so none of them burns its restart budget respawning a dead token. Pinned by
 * `__tests__/gateway-adapter-start.test.ts`.
 */
export function adapterStartFailureExitCode(err: unknown): number | undefined {
  return err instanceof AllAdaptersFailedError && err.permanent
    ? CONFIG_INVALID_EXIT_CODE
    : undefined;
}

/**
 * Start every platform adapter with per-adapter isolation (UBP-010).
 *
 * `Promise.all` let ONE rejected `start()` — a revoked Discord token, a Slack
 * socket that would not open — reject the whole command, exit 1 after Telegram
 * had already started polling, and burn the supervisor's restart budget with
 * every healthy bot offline. Here each rejection is warned about and recorded
 * as a `gateway.adapter_start_failed` observability event, and the others keep
 * serving. With `deps.retry`, each failed adapter is retried in the background
 * (`retryAdapterStart`: 5s doubling to 5min, jittered; stops on a permanent
 * credential error or when `retry.signal` aborts); `retrying` settles when
 * every retry loop has ended.
 *
 * When EVERY adapter failed, `allFailed` decides. `'throw'` (the default, used
 * by `ethos gateway start`, a process that exists only to serve its adapters)
 * rejects with an {@link AllAdaptersFailedError} and starts no retries, so a
 * gateway with nothing to serve still exits — with the refusal code when every
 * failure was a refused credential (`adapterStartFailureExitCode`). `'continue'`
 * (used by `ethos boot`, which also hosts the web UI, cron and serve —
 * V2-RT-5) resolves like a partial failure: the transient failures are retried,
 * the permanent ones abandoned, and the other services come up. Pinned by
 * `__tests__/gateway-adapter-start.test.ts`.
 */
export async function startAdaptersIsolated<A extends AdapterStartable>(
  adapters: ReadonlyArray<A>,
  deps: {
    observability: Pick<GatewayObservability, 'recordSafetyBlock'>;
    warn: (message: string) => void;
    retry?: AdapterStartRetryOptions<A>;
    /** What an all-adapters-failed start does. Default `'throw'`. */
    allFailed?: 'throw' | 'continue';
  },
): Promise<{
  started: string[];
  failed: { id: string; error: string }[];
  retrying: Promise<void>;
}> {
  const results = await Promise.allSettled(adapters.map((a) => a.start()));
  const started: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const toRetry: { adapter: A; reason: unknown }[] = [];
  let firstReason: unknown;
  results.forEach((result, i) => {
    const adapter = adapters[i];
    const id = adapter?.id ?? `adapter#${i}`;
    if (result.status === 'fulfilled') {
      started.push(id);
      return;
    }
    if (failed.length === 0) firstReason = result.reason;
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failed.push({ id, error });
    if (adapter) toRetry.push({ adapter, reason: result.reason });
    deps.warn(
      deps.retry
        ? `adapter ${id} failed to start: ${error} — the other adapters keep running; retrying in the background`
        : `adapter ${id} failed to start: ${error} — the other adapters keep running; restart the gateway once it is fixed`,
    );
    deps.observability.recordSafetyBlock({
      code: 'gateway.adapter_start_failed',
      cause: error,
      details: { adapterId: id },
    });
  });
  if (adapters.length > 0 && failed.length === adapters.length && deps.allFailed !== 'continue') {
    throw new AllAdaptersFailedError(
      firstReason,
      toRetry.every(({ reason }) => isPermanentAdapterStartError(reason)),
    );
  }
  const retry = deps.retry;
  const retrying = retry
    ? Promise.all(
        toRetry.map(({ adapter, reason }) =>
          retryAdapterStart(adapter, reason, deps, retry).catch(() => {}),
        ),
      ).then(() => {})
    : Promise.resolve();
  return { started, failed, retrying };
}
