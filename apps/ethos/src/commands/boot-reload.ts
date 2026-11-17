// `ethos boot`'s config live-reload phase (plan/phases/gateway-live-reload.md
// Phases 0, A, C, D), moved out of `runBoot` (./boot.ts) unchanged. It owns its
// reconcile state; `webServer`/`webRequested` and `reason` stay in `runBoot`
// (shutdown and `releaseBotLoops` read them), reached via `BootReloadContext`.

import { join } from 'node:path';
import type { EthosConfig, WebhookHookConfig } from '@ethosagent/config';
import { EthosError, type PlatformAdapter } from '@ethosagent/types';
import {
  appliedSliceFor,
  appliedStateOf,
  type ConfigSectionDiff,
  commitHotAdd,
  createReloadRunner,
  hotAddRefusalReason,
  loadAndDiffConfig,
  markApplied,
  markRetired,
  planReconcile,
  planWebRebind,
  type ReloadRunner,
  rebindWebServer,
  reconcilePending,
  replaceBotWiring,
  retireBotFully,
  shouldReloadConfig,
  sliceConfigForBot,
  sliceConfigForWebhook,
  startAndMountPlatformWebhook,
  swapBotLive,
  unmountPlatformWebhook,
} from '../config-reload';
import { CONFIG_RELOAD_DEBOUNCE_MS, CONFIG_RELOAD_INTERVAL_MS } from './boot-constants';
import type { BootBot, BootReloadContext } from './boot-context';
import {
  buildGatewayAdapters,
  buildGatewayBots,
  type GatewayBotWiring,
  gatewayTurnOrigin,
} from './gateway';

/** Synchronous, like the inline block it replaces. */
export function startConfigReload(ctx: BootReloadContext): {
  configReloadRunner: ReloadRunner;
  configReloadTimer: ReturnType<typeof setInterval>;
} {
  const {
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
  } = ctx;

  // Config live-reload — plan/phases/gateway-live-reload.md Phases 0, A and C.
  //
  // Phase 0 is the diff and the honest "restart required to apply" line for
  // every key that cannot hot-apply (§0 rows 7-10). Phase A is the reconciler
  // below it: a bot added, removed, or edited in `config.yaml` is applied to
  // the running gateway without bouncing web/ACP/cron along with it. Phase C
  // adds the two webhook route tables — the generic `webhooks:` block (§0 row
  // 5) and the native Telegram/Slack webhook-mode mounts (§0 row 6).
  //
  // `channel_filter` (Phase B) is NOT reconciled here, and that is the one
  // thing still bounding what may be accepted: a hot-added bot is only safe
  // when the running gateway ALREADY HAS an installed `channel_filter` entry
  // for its platform — which means one that was present in the configuration
  // this process booted with, since `Gateway.channelFilter` is assigned at
  // construction and nothing replaces it live. A filter an operator adds in
  // the SAME edit as the bot is in the file but not in force, so that
  // addition is refused, by name, until a restart installs it. Every running
  // bot is left untouched, and the cold-boot fatal gate in `runBoot` is unchanged.
  //
  // Poll, not `fs.watch`/`chokidar` (§1, §6) — the same poll-on-a-known-seam
  // shape `runBoot`'s personality refresh uses, for the same reason: a file
  // event fires on a HALF-written editor save, a poll just reads a moment
  // later. `ethos boot` only for v1 (§7.5): restart is already narrow in the
  // split `ethos gateway start`, so live-reload earns far less there.
  // --- Phase A reconciler -------------------------------------------------

  /**
   * What is ACTUALLY running, per unit — the thing a reconcile is planned
   * against. Cold boot applied all of `cfg`, so that is the seed; from here on
   * a unit only enters this ledger once its own reconcile has succeeded.
   */
  const applied = appliedStateOf(cfg);

  /**
   * Report a unit that is not live, without repeating itself on every poll.
   *
   * A failed or refused unit is NOT marked applied, so it is retried on every
   * subsequent poll — which is what turns a transient failure (a credential
   * the transport rejected once, a bot still draining a wedged turn) into a
   * self-healing one without an operator touching the file again.
   *
   * A MISSING `channel_filter` ENTRY IS NOT ONE OF THOSE. Adding the entry to
   * `config.yaml` does not install it in the running gateway (Phase B), so
   * that refusal repeats until the process is restarted — which is exactly
   * what its message says. The first appearance of a reason is the warning an
   * operator needs; every identical repeat is a debug line, so a permanently
   * refused bot does not drown the log.
   */
  const lastFailureReason = new Map<string, string>();
  const noteFailure = (kind: 'bot' | 'webhook', id: string, reason: string): void => {
    const key = `${kind}:${id}`;
    const detail = { component: 'config-reload', [kind]: id };
    if (lastFailureReason.get(key) === reason) {
      logger.debug(`[config-reload] ${kind} "${id}" still not applied — ${reason}`, detail);
      return;
    }
    lastFailureReason.set(key, reason);
    logger.warn(`[config-reload] ${kind} "${id}" not applied — ${reason}`, detail);
  };
  const noteApplied = (kind: 'bot' | 'webhook', id: string, what: string): void => {
    lastFailureReason.delete(`${kind}:${id}`);
    logger.info(`[config-reload] ${kind} "${id}" ${what}`, {
      component: 'config-reload',
      [kind]: id,
    });
  };
  /**
   * A live edit this process will not apply. `EthosError` rather than a raw
   * `Error` per the surface-code rule (`no-raw-throw.test.ts`); it is caught by
   * the reconcile loop and rendered through `noteFailure`, never to a terminal.
   */
  const refuse = (cause: string, action: string): EthosError =>
    new EthosError({ code: 'CONFIG_INVALID', cause, action });

  /** Everything a hot-add needs, built while the old instance still serves. */
  type PreparedBot = {
    bot: BootBot;
    adapter: PlatformAdapter;
    wiring: GatewayBotWiring;
    slice: EthosConfig;
  };

  /**
   * Build and validate one bot WITHOUT touching the running gateway.
   *
   * Every rejection lives here — the Phase-B-shaped refusal (a bot whose
   * platform has no INSTALLED `channel_filter` cannot be accepted until Phase B
   * can install one live), an identity that names nothing, a slice that builds
   * the wrong number of bots, a credential the builder throws on. A rejection
   * at this point is a no-op: nothing has been retired and nothing registered.
   */
  const prepareBotLive = async (id: string, source: EthosConfig): Promise<PreparedBot> => {
    // Phase B is not wired, which bounds what may be accepted here. The filter
    // state that decides is the one INSTALLED IN THE GATEWAY, never the parsed
    // file: `Gateway.channelFilter` is construction-time, so a filter added in
    // the same edit as the bot is not in force and admitting the bot on the
    // strength of the file would put it live under access control that was
    // never installed. A refusal is per-bot and non-fatal: every running bot
    // keeps serving, and the cold-boot `process.exit(1)` gate in `runBoot` is
    // untouched.
    const refusal = hotAddRefusalReason(source, id, (platform) =>
      gateway.hasChannelFilterFor(platform),
    );
    if (refusal) {
      throw refuse(
        refusal,
        'Fix the entry in ~/.ethos/config.yaml — a newly added channel_filter entry also needs a restart of ethos.',
      );
    }
    const slice = sliceConfigForBot(source, id);
    if (!slice) {
      throw refuse(
        'no matching entry in the reloaded config',
        'The bot identity named by the diff is not in config.yaml — re-save the file.',
      );
    }
    const built = await buildGatewayBots(
      slice,
      scheduler,
      watcherManager,
      gatewayTurnOrigin(() => gatewayRef),
      undefined,
      // A bot added without a restart is gated exactly like a cold-booted one.
      // This is the drift O-D8 warns about, one call site down: miss it and a
      // gated personality publishes unreviewed from whichever bot arrived last.
      outbox.wiring,
    );
    try {
      const newAdapters = await buildGatewayAdapters(slice, attachmentCache);
      const bot = built.bots[0];
      const adapter = newAdapters[0];
      if (!bot || !adapter || built.bots.length !== 1 || newAdapters.length !== 1) {
        throw refuse(
          'the config slice did not build exactly one bot and one adapter',
          'Check the entry in ~/.ethos/config.yaml — its credentials or personality binding are incomplete.',
        );
      }
      const wiring = built.perBot.get(bot.botKey);
      if (!wiring) {
        throw refuse(
          'the config slice built a bot the builder did not attribute',
          'This is a wiring bug — file an issue.',
        );
      }
      return { bot, adapter, wiring, slice };
    } catch (err) {
      // F06 — a refusal after the build must not strand the loop it built.
      await Promise.allSettled(built.disposers.map((dispose) => dispose()));
      throw err;
    }
  };

  /**
   * Register, wire and start a prepared bot as ONE transaction.
   *
   * `commitHotAdd` owns the ordering and the rollback: if the wiring or the
   * start fails, the route is unmounted, the wiring undone and the bot
   * deregistered (which stops the adapter), so the next poll's retry meets an
   * empty routing table rather than the duplicate-botKey guard.
   *
   * Returns the wiring undo for the caller to hold.
   */
  const commitBotLive = async (id: string, prepared: PreparedBot): Promise<() => Promise<void>> => {
    const { bot, adapter, wiring, slice } = prepared;
    let routes: string[] = [];
    const undoWiring = await commitHotAdd({
      // Runtime duplicate guard lives in `Gateway.addAdapter`; this call throws
      // rather than replacing a live routing-table entry.
      register: () => gateway.addAdapter(adapter, bot),
      wire: () => registerBotLive(bot, wiring, [adapter]),
      // Phase C, §0 row 6 — start THIS adapter, then mount THIS adapter's
      // native webhook route, as one sequence. The cold-boot path gets the same
      // ordering per BOOT by placing `buildPlatformWebhookMounts` after
      // `startAdaptersIsolated(adapters, …)`; a hot-add needs it per ADAPTER,
      // which is what `startAndMountPlatformWebhook` is. A non-webhook-mode bot
      // mounts nothing and the call is just a start.
      start: async () => {
        const mounted = await startAndMountPlatformWebhook(
          adapter,
          slice,
          platformWebhookMounts,
          (message) => logger.warn(message),
        );
        routes = [...mounted.telegram.map((k) => `/telegram/webhook/${k}`), ...mounted.slack];
        if (routes.length > 0) ensurePlatformWebhookServer();
      },
      unmount: () => {
        unmountPlatformWebhook(platformWebhookMounts, adapter);
      },
      deregister: () => gateway.removeAdapter(bot.botKey),
      onRollbackError: (err) =>
        logger.warn(`[config-reload] bot "${id}" rollback step failed`, {
          component: 'config-reload',
          bot: id,
          error: reason(err),
        }),
      // F06 — a commit that throws releases the prepared loop, even when
      // `register` fails before `wire` ran. The wiring undo may already have;
      // the loop's dispose is idempotent.
      release: () => releaseBotLoops(wiring, id),
    });
    if (routes.length > 0) {
      logger.info(`[config-reload] bot "${id}" webhook route mounted`, {
        component: 'config-reload',
        bot: id,
        routes: routes.join(', '),
      });
    }
    return undoWiring;
  };

  const addBotLive = async (id: string, source: EthosConfig): Promise<void> => {
    const prepared = await prepareBotLive(id, source);
    botWiring.set(prepared.bot.botKey, await commitBotLive(id, prepared));
  };

  /**
   * Retire one bot's TRANSPORT: unmount its native webhook route, drain its
   * in-flight turns, deregister it, stop its adapter. The app-level wiring is
   * left alone — `removeBotLive` undoes it, and the swap path keeps it so a
   * restore has something to come back to.
   */
  /**
   * After a swap: announce the jobs the outgoing loop's executor interrupted.
   * `removeAdapter` unsubscribed that executor before the swap disposed its
   * loop, so its jobs finished as interrupted-by-shutdown with no gateway
   * listening; only the store sweep sees them (`Gateway.sweepUndeliveredJobs`,
   * the same durable claim the boot sweep takes). Never throws.
   */
  const sweepInterruptedJobs = async (id: string): Promise<void> => {
    try {
      await gateway.sweepUndeliveredJobs();
    } catch (err) {
      logger.warn(`[config-reload] bot "${id}" post-swap job sweep failed`, {
        component: 'config-reload',
        bot: id,
        error: reason(err),
      });
    }
  };

  const retireBotTransport = async (id: string): Promise<void> => {
    const botKey = id.slice(id.indexOf(':') + 1);
    // Unmount BEFORE the adapter is deregistered and stopped, so no delivery
    // reaches a handler whose adapter is on its way down. Resolved from the
    // live adapter list, which still answers for a cold-booted bot — the
    // mount table is not restricted to hot-added ones.
    const adapter = gateway.listAdapters().find((a) => a.id === id);
    if (adapter) unmountPlatformWebhook(platformWebhookMounts, adapter);
    await gateway.removeAdapter(botKey);
  };

  const removeBotLive = async (id: string): Promise<void> => {
    const botKey = id.slice(id.indexOf(':') + 1);
    // Transport first, wiring second — see `retireBotFully`. A drain that does
    // not finish within the abort grace leaves the bot QUARANTINED and still
    // fully wired, and throws; undoing the wiring first would have pulled the
    // approval flow, clarify correlator, routers, messaging bindings and
    // refreshers out from under the turn that is still running, with the
    // teardown handle already deleted so the retry could not restore it.
    await retireBotFully(botWiring, botKey, () => retireBotTransport(id));
  };

  /**
   * The configuration a unit is RUNNING — the only correct rollback source.
   *
   * Not "the config that parsed before this one": if version B parses and a
   * bot fails to apply, and version C is then saved, a failed C replacement
   * would rebuild B — a configuration that was never live — while the applied
   * ledger still says A. The ledger and the rollback source have to be the
   * same record, so both come from `applied`.
   */
  const appliedSliceOrRefuse = (kind: 'bot' | 'webhook', id: string): EthosConfig => {
    const slice = appliedSliceFor(applied, kind, id);
    if (!slice) {
      throw refuse(
        `no applied configuration recorded for ${kind} "${id}"`,
        'Restart ethos — the running configuration for this unit cannot be reconstructed.',
      );
    }
    return slice;
  };

  /**
   * Replace a live bot with a rebuilt one. See `swapBotLive` for why the
   * replacement is BUILT before the old instance is retired, and why it cannot
   * also be STARTED first.
   */
  const changeBotLive = async (id: string, source: EthosConfig): Promise<void> => {
    const botKey = id.slice(id.indexOf(':') + 1);
    await swapBotLive({
      prepare: () => prepareBotLive(id, source),
      retire: () => retireBotTransport(id),
      afterSwap: () => sweepInterruptedJobs(id),
      // F06 — a quarantined old bot makes `retire` throw; the replacement's
      // loop is released instead of stranded.
      release: (prepared) => releaseBotLoops(prepared.wiring, id),
      commit: async (prepared) => {
        const undoWiring = await commitBotLive(id, prepared);
        // The replacement is live, so the outgoing registration can go. Its
        // undos are identity-based and cannot touch the new one.
        await replaceBotWiring(botWiring, botKey, undoWiring);
      },
      // NOT the adapter object `retire` just stopped — a fresh one, built from
      // the APPLIED slice and committed through the same transaction a hot-add
      // uses. `PlatformAdapter` promises nothing about `start()` after
      // `stop()`; see `swapBotLive`.
      rebuildPrevious: () => {
        logger.warn(
          `[config-reload] bot "${id}" replacement failed — rebuilding the instance that was running`,
          { component: 'config-reload', bot: id },
        );
        return prepareBotLive(id, appliedSliceOrRefuse('bot', id));
      },
      onRestoreFailed: (err) =>
        logger.error(`[config-reload] bot "${id}" is NOT running — the rebuild also failed`, {
          component: 'config-reload',
          bot: id,
          error: reason(err),
        }),
    });
  };

  // --- Phase C reconciler: generic webhook routes (§0 row 5) --------------
  //
  // A `webhooks.<hookId>` entry is TWO things: a route on the webhook server
  // and a first-class `webhook:<hookId>` bot in the gateway's routing table
  // (that is how `buildGatewayBots` builds it at cold boot). Serving the route
  // without registering the bot would answer the POST and then drop the
  // message at `no_bot_available` — so both move together, and the ORDER is
  // the same discipline as the adapter mount above: register the bot first,
  // then open the route; close the route first, then deregister the bot.

  /** Built while the existing route, if any, is still being served. */
  type PreparedWebhook = {
    bot: BootBot;
    wiring: GatewayBotWiring;
    hook: WebhookHookConfig;
  };

  const prepareWebhookLive = async (
    hookId: string,
    source: EthosConfig,
  ): Promise<PreparedWebhook> => {
    const slice = sliceConfigForWebhook(source, hookId);
    const hook = source.webhooks?.[hookId];
    if (!slice || !hook) {
      throw refuse(
        'no matching entry in the reloaded config',
        'The hookId named by the diff is not under `webhooks:` in config.yaml — re-save the file.',
      );
    }
    const built = await buildGatewayBots(
      slice,
      scheduler,
      watcherManager,
      gatewayTurnOrigin(() => gatewayRef),
      undefined,
      // A bot added without a restart is gated exactly like a cold-booted one.
      // This is the drift O-D8 warns about, one call site down: miss it and a
      // gated personality publishes unreviewed from whichever bot arrived last.
      outbox.wiring,
    );
    try {
      const bot = built.bots[0];
      if (!bot || built.bots.length !== 1) {
        throw refuse(
          `the config slice built ${built.bots.length} bots, not one`,
          'Check the `webhooks:` entry in ~/.ethos/config.yaml — its personality binding is incomplete.',
        );
      }
      const wiring = built.perBot.get(bot.botKey);
      if (!wiring) {
        throw refuse(
          'the config slice built a bot the builder did not attribute',
          'This is a wiring bug — file an issue.',
        );
      }
      return { bot, wiring, hook };
    } catch (err) {
      // F06 — a refusal after the build must not strand the loop it built.
      await Promise.allSettled(built.disposers.map((dispose) => dispose()));
      throw err;
    }
  };

  /**
   * Register a prepared route as one transaction. The bot goes in BEFORE the
   * route opens — serving the POST without a bot in the routing table would
   * answer the request and then drop the message at `no_bot_available`.
   *
   * A webhook bot has no `PlatformAdapter` of its own (its transport is the
   * webhook server's per-request capturing adapter), so `start` is the route
   * opening and `unmount` is closing it again.
   */
  const commitWebhookLive = async (
    hookId: string,
    prepared: PreparedWebhook,
  ): Promise<() => Promise<void>> =>
    commitHotAdd({
      register: () => gateway.addBot(prepared.bot),
      wire: () => registerBotLive(prepared.bot, prepared.wiring, []),
      start: async () => {
        liveWebhooks[hookId] = prepared.hook;
        ensureWebhookServer();
      },
      unmount: () => {
        delete liveWebhooks[hookId];
      },
      // `removeAdapter` on a bot that never had one: its deregistration path is
      // adapter-optional by design (see `Gateway.addBot`), so this drains the
      // route's in-flight turns and drops its lanes without touching anything
      // else. There is no transport to stop.
      deregister: () => gateway.removeAdapter(`webhook:${hookId}`),
      onRollbackError: (err) =>
        logger.warn(`[config-reload] webhook "${hookId}" rollback step failed`, {
          component: 'config-reload',
          hook: hookId,
          error: reason(err),
        }),
      // F06 — same release-on-failure as `commitBotLive`.
      release: () => releaseBotLoops(prepared.wiring, `webhook:${hookId}`),
    });

  const addWebhookRouteLive = async (hookId: string, source: EthosConfig): Promise<void> => {
    const prepared = await prepareWebhookLive(hookId, source);
    botWiring.set(prepared.bot.botKey, await commitWebhookLive(hookId, prepared));
  };

  const retireWebhookTransport = async (hookId: string): Promise<void> => {
    delete liveWebhooks[hookId];
    await gateway.removeAdapter(`webhook:${hookId}`);
  };

  /** Same transport-then-wiring ordering as `removeBotLive`, for the same
   *  reason: a webhook bot's drain can be deferred too. */
  const removeWebhookRouteLive = async (hookId: string): Promise<void> => {
    await retireBotFully(botWiring, `webhook:${hookId}`, () => retireWebhookTransport(hookId));
  };

  /** Same build-then-retire ordering as `changeBotLive`, for the same reason. */
  const changeWebhookRouteLive = async (hookId: string, source: EthosConfig): Promise<void> => {
    const botKey = `webhook:${hookId}`;
    await swapBotLive({
      prepare: () => prepareWebhookLive(hookId, source),
      retire: () => retireWebhookTransport(hookId),
      release: (prepared) => releaseBotLoops(prepared.wiring, `webhook:${hookId}`),
      commit: async (prepared) => {
        const undoWiring = await commitWebhookLive(hookId, prepared);
        await replaceBotWiring(botWiring, botKey, undoWiring);
      },
      // Rebuilt from the APPLIED slice, not re-registered from the object that
      // was just retired and not rebuilt from the previously parsed file — the
      // same rule `changeBotLive` follows, so the two swap paths cannot drift.
      rebuildPrevious: () => {
        logger.warn(
          `[config-reload] webhook "${hookId}" replacement failed — rebuilding the route that was being served`,
          { component: 'config-reload', hook: hookId },
        );
        return prepareWebhookLive(hookId, appliedSliceOrRefuse('webhook', hookId));
      },
      onRestoreFailed: (err) =>
        logger.error(
          `[config-reload] webhook "${hookId}" is NOT served — the rebuild also failed`,
          {
            component: 'config-reload',
            hook: hookId,
            error: reason(err),
          },
        ),
    });
  };

  /**
   * Apply the outstanding `bots` work.
   *
   * `applied` — not the parsed file — is what this is driven from, and a unit
   * is marked applied only after its own reconcile RETURNED. One bot that fails
   * neither aborts the others nor gets recorded as live: it stays in the next
   * `planReconcile` result and is retried on the following poll, whether or not
   * the file has been touched again.
   */
  const applyBotPlan = async (plan: ConfigSectionDiff, source: EthosConfig): Promise<void> => {
    for (const id of plan.removed) {
      try {
        await removeBotLive(id);
        markRetired(applied, 'bot', id);
        noteApplied('bot', id, 'removed live');
      } catch (err) {
        noteFailure('bot', id, reason(err));
      }
    }
    for (const id of plan.changed) {
      try {
        await changeBotLive(id, source);
        markApplied(applied, source, 'bot', id);
        noteApplied('bot', id, 'replaced live');
      } catch (err) {
        noteFailure('bot', id, reason(err));
      }
    }
    for (const id of plan.added) {
      try {
        await addBotLive(id, source);
        markApplied(applied, source, 'bot', id);
        noteApplied('bot', id, 'added live');
      } catch (err) {
        noteFailure('bot', id, reason(err));
      }
    }
  };

  /** The `webhooks` half of `applyBotPlan`, with the same ledger discipline. */
  const applyWebhookPlan = async (plan: ConfigSectionDiff, source: EthosConfig): Promise<void> => {
    for (const hookId of plan.removed) {
      try {
        await removeWebhookRouteLive(hookId);
        markRetired(applied, 'webhook', hookId);
        noteApplied('webhook', hookId, 'removed live');
      } catch (err) {
        noteFailure('webhook', hookId, reason(err));
      }
    }
    for (const hookId of plan.changed) {
      try {
        await changeWebhookRouteLive(hookId, source);
        markApplied(applied, source, 'webhook', hookId);
        noteApplied('webhook', hookId, 'replaced live');
      } catch (err) {
        noteFailure('webhook', hookId, reason(err));
      }
    }
    for (const hookId of plan.added) {
      try {
        await addWebhookRouteLive(hookId, source);
        markApplied(applied, source, 'webhook', hookId);
        noteApplied('webhook', hookId, 'added live');
      } catch (err) {
        noteFailure('webhook', hookId, reason(err));
      }
    }
  };

  // --- Phase D reconciler: the web bind (§0 row 9) ------------------------
  //
  // ONE SERVER, AND NOTHING ELSE. `rebindWebServer` is handed the listener,
  // the two addresses, the same fallback ladder cold boot used, and the
  // WebSocket re-attach — no `AgentLoop`, no session store, no job store, no
  // mesh registration, no gateway. Sessions in flight over the ACP or channel
  // adapters do not notice; a browser holding the dashboard reconnects.
  //
  // A brief close-then-listen gap is expected and accepted (plan §6).
  /** `host:port` of a rebind that failed and FELL BACK. A working listener is
   *  worth more than a retry loop that bounces it every ten seconds, so this
   *  one waits for the operator to change the address again. */
  let webRebindRefused: string | null = null;

  const applyWebBindDiff = async (
    source: EthosConfig,
    announceSkip: boolean,
  ): Promise<'skipped' | 'rebound'> => {
    const decision = planWebRebind(web.requested, source, args, process.env);
    if (decision.action === 'skip') {
      if (announceSkip) {
        logger.debug(`[config-reload] web bind unchanged — ${decision.reason}`, {
          component: 'config-reload',
        });
      }
      return 'skipped';
    }
    const wanted = `${decision.target.host}:${decision.target.port}`;
    if (webRebindRefused === wanted) return 'skipped';
    const outcome = await rebindWebServer({
      server: web.server,
      current: web.requested,
      target: decision.target,
      listen: listenWeb,
      onListening: attachWebSockets,
      logger,
    });
    web.server = outcome.server;
    web.requested = outcome.requested;
    webRebindRefused = outcome.fellBack ? wanted : null;
    const warning = announceWebBind(outcome.requested.host, outcome.port);
    if (warning) console.warn(warning);
    return 'rebound';
  };

  const configFilePath = join(dir, 'config.yaml');
  /** The last config that PARSED — what the next diff is computed against.
   *  NOT a rollback source: what a failed replacement is rebuilt from is the
   *  per-unit slice in `applied`, which records what each unit is RUNNING. */
  let liveConfig: EthosConfig = cfg;
  let lastConfigMtimeMs: number | null = null;
  let lastConfigReloadMs = 0;
  let configReloadInFlight = false;
  /** A rebind that left NOTHING listening. Retried on every poll — there is no
   *  working dashboard left to protect. */
  let webRebindPending = false;

  const reloadConfig = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastConfigReloadMs < CONFIG_RELOAD_DEBOUNCE_MS) return;
    lastConfigReloadMs = now;
    if (configReloadInFlight) return;
    configReloadInFlight = true;
    try {
      // mtime gate before the STRICT parse. `loadConfigStrict` resolves every
      // `${secrets:ref}` in the file, which for an AWS-backed resolver is a
      // network call per reference — polling that every tick on an unchanged
      // file would be pure waste (§7.1's "wasted work" concern). A unit that
      // failed to apply outranks the gate: its retry is owed regardless of
      // whether anybody touches the file again.
      const mtimeMs = await storage.mtime(configFilePath);
      const pending = webRebindPending || reconcilePending(applied, liveConfig);
      if (!shouldReloadConfig({ mtimeMs, lastMtimeMs: lastConfigMtimeMs, pending })) return;
      const fileMoved = mtimeMs === null || mtimeMs !== lastConfigMtimeMs;
      if (fileMoved) {
        lastConfigMtimeMs = mtimeMs;
        const next = await loadAndDiffConfig(liveConfig, { storage, secrets, logger });
        if (!next) {
          // Unreadable, mid-write, or a parse error. Keep the last config that
          // parsed, and drop the mtime so the retry is not gated on a further
          // edit.
          lastConfigMtimeMs = null;
          return;
        }
        liveConfig = next.config;
      }
      const plan = planReconcile(applied, liveConfig);
      await applyBotPlan(plan.bots, liveConfig);
      await applyWebhookPlan(plan.webhooks, liveConfig);
      // Both listeners are bound on demand, so they are released on demand
      // too. Done HERE rather than inside each removal so a swap — retire then
      // re-add, which empties a route table for an instant — does not bounce
      // the port, while every path that genuinely leaves no route behind (a
      // removal, a rolled-back add, a replacement that failed both ways) is
      // covered by the same two calls.
      releaseWebhookServerIfIdle();
      releasePlatformWebhookServerIfIdle();
      // LAST, and guarded on its own: the web bind is the only reconcile that
      // drops a listening socket, so a failure there must not be able to
      // abort the bot/webhook reconciles that already succeeded above.
      try {
        await applyWebBindDiff(liveConfig, fileMoved);
        webRebindPending = false;
      } catch (err) {
        webRebindPending = true;
        logger.warn('[config-reload] web bind could not be applied', {
          component: 'config-reload',
          error: reason(err),
        });
      }
    } finally {
      configReloadInFlight = false;
    }
  };
  /**
   * The poll, and the handle shutdown stops it by.
   *
   * Clearing the interval only stops the NEXT reconcile. The one already
   * running can be halfway through adding a bot, replacing an adapter or
   * rebinding the web server — all of which shutdown is concurrently tearing
   * down, so a listener or an adapter created after cleanup walked past it
   * survives the exit. `stop()` therefore latches the refusal first and then
   * awaits the reconcile in flight; see `createReloadRunner`.
   */
  const configReloadRunner = createReloadRunner(reloadConfig, (err) =>
    logger.warn('[config-reload] reconcile failed', {
      component: 'config-reload',
      error: reason(err),
    }),
  );
  const configReloadTimer = setInterval(
    () => configReloadRunner.trigger(),
    CONFIG_RELOAD_INTERVAL_MS,
  );
  configReloadTimer.unref?.();

  return { configReloadRunner, configReloadTimer };
}
