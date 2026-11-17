// `ethos gateway start` — the approval flow: one card hook per bot loop, the
// no-surface gate for loops with no card-capable adapter, and the shutdown
// handle that denies pending cards. Split out of gateway.ts, which re-exports
// `wireApprovalFlow`; `ethos boot` calls it through that re-export.

import type { Gateway, GatewayBotConfig } from '@ethosagent/gateway';
import type {
  ExecutionPosture,
  LLMProvider,
  PersonalityRegistry,
  PlatformAdapter,
} from '@ethosagent/types';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createApprovalDangerPredicate,
  hardlineReason,
  markHostApprovalGate,
  notPermittedRefusal,
  type SmartApproverDecisionSite,
} from '@ethosagent/wiring';
import {
  ApprovalCoordinator,
  type ApprovalObservability,
  createSlackApprovalHook,
  SYSTEM_DECIDER,
} from '../approval-coordinator';
import { createNoApprovalSurfaceGate } from '../unattended-approval-gate';
import { getEthosObservability } from '../wiring';

// `import type` only — erased at runtime, so `@ethosagent/platform-slack`
// stays lazily loaded via `loadAdapterModule` and the layering is unchanged.
// The approval contract lives in `@ethosagent/types` so any adapter
// (Slack, Telegram, future) can implement it without cross-platform imports.
export type ApprovalCapableAdapter = import('@ethosagent/types').ApprovalCapableAdapter;

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

/** How long `wireApprovalFlow`'s shutdown waits for in-flight approval card
 *  posts and updates. A card round trip is well under this; a hung adapter
 *  costs a stale card rather than a shutdown that never returns. */
const APPROVAL_SHUTDOWN_DRAIN_MS = 5_000;

/**
 * Give every bot loop in `bots` exactly one approval gate on
 * `before_tool_call`, and connect the card-capable ones to approval cards.
 * This is the ONE call every bot-loop host makes — `ethos gateway start`
 * (`runGatewayStart`, all bots at once) and `ethos boot` (`registerBotLive`,
 * per bot: cold boot, live hot-add, webhook-route bots, and a bot replaced on
 * config reload) — so no host can leave a bot loop ungated.
 *
 *   0. A bot with NO approval-capable adapter (WhatsApp, Email, a webhook
 *      route bot — anything without `postApprovalCard`; today only Slack,
 *      Telegram and Discord implement it) gets the no-surface gate
 *      (`createNoApprovalSurfaceGate`, apps/ethos/src/unattended-approval-gate.ts):
 *      a flagged call is ALWAYS refused. A remote sender drives these turns,
 *      so the systemLoop's D12 opt-in (`approvalMode: off` +
 *      `allowUnattendedDangerousTools`) is never honoured here. This includes
 *      the case where no adapter at all is approval-capable, which returns
 *      right after. The idle gateway bot (no bot configured) is not in
 *      `bots` and is not gated here: its turns run on the systemLoop, where
 *      `wireUnattendedApprovalGate`'s `isRemoteSenderTurn` split hands them to
 *      this same no-surface gate, so the rule is identical — a remote-sender
 *      turn never gets the opt-in (pinned by
 *      `../__tests__/unattended-approval-gate.test.ts`, 'idle gateway').
 *   1. `before_tool_call` hook on every approval-capable bot loop →
 *      `ApprovalCoordinator` suspends dangerous calls. A turn on such a loop
 *      that arrived through an adapter that cannot post a card is handed to
 *      the same no-surface gate (`withoutSurface`) and refused, not let
 *      through.
 *   2. `coordinator.onPending` → resolve the sessionId to its adapter/chat/
 *      thread via the gateway and post an approval card.
 *   3. each adapter's button-click event → `coordinator.approve/deny`
 *      and an in-place update of the card.
 *
 * Pinned by `__tests__/approval-flow-unattended.test.ts`.
 *
 * Returns a `{ shutdown, pendingCount }` handle: the caller's SIGINT/SIGTERM
 * closure calls `shutdown` so pending approvals are force-settled (deny +
 * audit + card update) before the process exits, and the idle watcher reads
 * `pendingCount` — an unanswered approval is in-flight work, and exiting on
 * one loses it silently (plan/phases/idle-watcher.md §1 check #11). Exported
 * so tests can exercise the config threading and those handles without
 * booting a real gateway.
 */
export function wireApprovalFlow(
  gateway: Gateway,
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  seams: {
    /** The gateway's hot-reloaded read registry — the same one `/personality`
     *  validates against, so a switched personality's approval policy applies
     *  on its next turn. */
    personalities: PersonalityRegistry;
    /** Lazy provider handle for `approvalMode: 'smart'`. */
    getProvider: () => Promise<LLMProvider>;
    /** Model the smart reviewer runs on. */
    model: string;
    /** Operator's approval SLA (`config.approvalTimeoutMs`). Undefined → the
     *  coordinator's own 10-minute default; `0` → no timeout. */
    approvalTimeoutMs?: number;
    /** The platform owner (`channel_filter.<platform>.ownerUserId`), who
     *  decides approvals for turns started in a group chat. Required so no
     *  caller can silently fall back to requester binding in groups. */
    ownerFor: (platform: string) => string | undefined;
    /** The smart reviewer's decision site (plan decision-provider-jev §8.2),
     *  forwarded to every predicate built here. Operator-level config, so one
     *  site serves every bot; absent → the LLM reviewer only. */
    decision?: SmartApproverDecisionSite;
    /** `CreateAgentLoopResult.executionPostureFor` — required by every
     *  predicate built here (S6 / D1(a)). Posture is operator- and
     *  personality-level, so one build's resolver serves every bot. */
    executionPostureFor: (personalityId: string | undefined) => ExecutionPosture | undefined;
    /** `CreateAgentLoopResult.usageMeter` of that same build — meters the smart reviewer. */
    usageMeter: Pick<import('@ethosagent/wiring').UsageMeter, 'meter'>;
  },
): { shutdown: () => Promise<void>; pendingCount: () => number } {
  const approvalAdapters = adapters.filter(isApprovalCapable);
  const approvalBotKeys = new Set(approvalAdapters.map((a) => a.botKey));
  const noSurfaceOpts = {
    personalities: seams.personalities,
    getProvider: seams.getProvider,
    model: seams.model,
    ...(seams.decision ? { decision: seams.decision } : {}),
    executionPostureFor: seams.executionPostureFor,
    usageMeter: seams.usageMeter,
  };
  // Wire 0: a bot with no approval surface is gated here, before the
  // early return below, so a deployment with no card-capable adapter at all
  // is covered too.
  for (const bot of bots) {
    if (approvalBotKeys.has(bot.botKey)) continue;
    bot.loop.hooks.registerModifying(
      'before_tool_call',
      createNoApprovalSurfaceGate([bot.loop.hooks], noSurfaceOpts),
    );
    // The loop's terminal/process guards now leave approval-required commands
    // (command substitution) to this gate, which refuses them here.
    markHostApprovalGate(bot.loop.hooks);
  }
  // No approval surface — hand back a no-op handle so the caller needs no
  // null check in its shutdown closure. Nothing can ever be pending here.
  if (approvalAdapters.length === 0) return { shutdown: async () => {}, pendingCount: () => 0 };

  // Every settled approval lands in the safety audit trail (`ethos audit
  // decisions`). Resolved lazily so a boot that never touches observability
  // doesn't open the DB; the coordinator swallows any failure here.
  const observability: ApprovalObservability = {
    recordSafetyApproval: (opts) => getEthosObservability().recordSafetyApproval(opts),
  };
  const coordinator = new ApprovalCoordinator({
    observability,
    // `!== undefined`, not truthiness — `0` ("wait forever") is a meaningful
    // operator setting, not an absent one.
    ...(seams.approvalTimeoutMs !== undefined ? { timeoutMs: seams.approvalTimeoutMs } : {}),
  });
  // UBP-046 — `/stop` settles the stopped turn's pending approval now (card
  // updated via `onResolved`, lane released), not at the approval timeout.
  // Pinned by `../__tests__/stop-settles-approval.test.ts`.
  const offLaneStop = gateway.onLaneStop(({ sessionId }) =>
    coordinator.cancelForSession(sessionId, 'turn stopped'),
  );

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
  // The same posts as awaitable promises. A `Set<string>` can be tested but not
  // awaited, and shutdown must await these: a post that completes mid-shutdown
  // fires `updateCard` from its own `.then()`, creating a card update that no
  // snapshot taken at the top of `shutdown()` could have contained. Each entry
  // is the TAIL of the post chain, so by the time it settles the update it
  // spawned is already registered in `inFlightCardUpdates`.
  const inFlightCardPosts = new Set<Promise<unknown>>();
  // Card updates genuinely in flight. `updateApprovalCard` is a network round
  // trip, and a settle fires it fire-and-forget; without this the shutdown
  // path would tear the adapter out from under the update and leave a denied
  // approval rendering live Allow/Deny buttons in the channel.
  const inFlightCardUpdates = new Set<Promise<unknown>>();

  // Resolve a `sessionId` to its approval target. Returns `undefined` for
  // any turn whose route isn't an approval-capable adapter; the hook then
  // hands the call to `withoutSurface` (the no-surface gate).
  //
  // `requesterUserId` is the one user the coordinator lets decide
  // (`ApprovalCoordinator.settle` drops every other click). In a DM that is
  // the requester — the only human in the lane. In a group it is the platform
  // owner, so a member cannot approve their own dangerous call (plan
  // openclaw-advisory-fixes L-c, D20). A group on a platform with no owner
  // configured keeps requester binding (D21): refusing every approval there
  // would make the bot unusable, and the requester is still the only clicker
  // accepted. Pinned by apps/ethos/src/commands/__tests__/approval-target.test.ts.
  const resolveApprovalTarget = (sessionId: string) => {
    const route = gateway.resolveApprovalRoute(sessionId);
    if (!route || !isApprovalCapable(route.adapter)) return undefined;
    return {
      requesterUserId: route.isDm
        ? route.requesterUserId
        : (seams.ownerFor(route.platform) ?? route.requesterUserId),
    };
  };

  // Register the approval hook only on loops whose bot has an
  // approval-capable adapter (every other bot got the no-surface gate above).
  const approvalBots = bots.filter((bot) => approvalBotKeys.has(bot.botKey));
  // One predicate for all approval bots. It learns each turn's personality
  // from the owning loop's `session_start`, so `approvalMode` follows
  // whatever personality the lane is actually running — including a
  // `/personality` switch. The reviewer and its provider stay unconstructed
  // unless a flagged call reaches `approvalMode: 'smart'`.
  const isDangerous = createApprovalDangerPredicate({
    hooks: approvalBots.map((bot) => bot.loop.hooks),
    personalities: seams.personalities,
    getProvider: seams.getProvider,
    model: seams.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    ...(seams.decision ? { decision: seams.decision } : {}),
    executionPostureFor: seams.executionPostureFor,
    usageMeter: seams.usageMeter,
  });
  // A turn on one of these loops that arrived through an adapter with no card
  // (an Email message that fell back to a Slack bot's loop) cannot be asked:
  // the no-surface gate refuses a flagged call, as on a bot with no card.
  const withoutSurface = createNoApprovalSurfaceGate(
    approvalBots.map((bot) => bot.loop.hooks),
    noSurfaceOpts,
  );
  for (const bot of approvalBots) {
    bot.loop.hooks.registerModifying(
      'before_tool_call',
      createSlackApprovalHook({
        coordinator,
        isDangerous,
        resolveApprovalTarget,
        withoutSurface,
        hardlineReason,
        // No card for a call this bot's personality allowlist refuses anyway.
        refusedAnyway: notPermittedRefusal(bot.loop),
      }),
    );
    // Approval-required commands (command substitution) now reach the card
    // instead of the loop's terminal/process guard refusing them first.
    markHostApprovalGate(bot.loop.hooks);
  }

  // Update a posted card to its resolved state. Shared by the normal
  // `onResolved` path and the post-races-resolution recovery path.
  const updateCard = (
    card: { adapter: ApprovalCapableAdapter; chatId: string; messageTs: string; toolName: string },
    decision: 'allow' | 'deny',
    decidedBy: string,
  ): void => {
    const update = card.adapter
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
      })
      .finally(() => {
        inFlightCardUpdates.delete(update);
      });
    inFlightCardUpdates.add(update);
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
      void coordinator.deny(req.approvalId, SYSTEM_DECIDER);
      return;
    }
    const adapter = route.adapter;
    inFlightPosts.add(req.approvalId);
    const post: Promise<unknown> = adapter
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
          void coordinator.deny(req.approvalId, SYSTEM_DECIDER);
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
        void coordinator.deny(req.approvalId, SYSTEM_DECIDER);
      })
      .finally(() => {
        inFlightCardPosts.delete(post);
      });
    inFlightCardPosts.add(post);
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
        void coordinator.deny(event.approvalId, event.decidedBy, event.note);
      }
    });
  }

  return {
    // `forceSettleAll` is synchronous (settle → audit → resolve), but each
    // settle fires `onResolved` → `updateCard`, an async round trip. Drain
    // those before returning so the caller can stop its adapters without
    // stranding a denied approval's card with live buttons.
    //
    // A LOOP, not a single `allSettled`: `forceSettleAll` settles every
    // pending approval, including any whose card post is still on the wire.
    // Awaiting such a post lets its `.then()` drain `resolvedBeforePost` and
    // fire a card update that did not exist when the drain started, so both
    // sets are re-read each pass. Bounded, because this runs on the
    // SIGINT/SIGTERM path: a hung adapter must cost a stale card, not a
    // shutdown that never completes.
    shutdown: async () => {
      offLaneStop();
      coordinator.forceSettleAll();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), APPROVAL_SHUTDOWN_DRAIN_MS);
      });
      try {
        while (inFlightCardPosts.size > 0 || inFlightCardUpdates.size > 0) {
          const drained = Promise.allSettled([...inFlightCardPosts, ...inFlightCardUpdates]).then(
            () => 'drained' as const,
          );
          if ((await Promise.race([drained, deadline])) === 'expired') {
            console.warn(
              `[gateway] approval shutdown gave up after ${APPROVAL_SHUTDOWN_DRAIN_MS}ms with ` +
                `${inFlightCardPosts.size} card post(s) and ${inFlightCardUpdates.size} ` +
                'card update(s) outstanding',
            );
            return;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
    pendingCount: () => coordinator.pendingCount(),
  };
}
