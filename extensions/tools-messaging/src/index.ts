import { laneKeyBotKey } from '@ethosagent/core';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

/**
 * Every platform `send_message` can address. Single source of truth: the
 * schema enum the model sees and the rejection message a bad call gets are
 * both derived from it, so the two can never disagree about what is supported.
 *
 * `OUTBOUND_POLICY_PLATFORMS` in `extensions/personalities/src/index.ts` — the
 * platforms `outbound_policy.channels` may name — is a deliberate COPY of this
 * list, not shared code, because `@ethosagent/personalities` must not import a
 * sibling extension (O-D2). The two are pinned equal by
 * `packages/wiring/src/__tests__/outbound-policy-platforms.test.ts`, the lowest
 * layer that can import both. **They must change together:** a platform added
 * here and not there cannot be gated; one removed there and not here goes back
 * to sending ungated.
 */
export const SEND_MESSAGE_PLATFORMS = [
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'email',
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MessagingSendFn = (
  platform: string,
  target: string,
  body: string,
  botKey?: string,
) => Promise<{
  ok: boolean;
  error?: string;
}>;

// ---------------------------------------------------------------------------
// The approval outbox seam (O-T3, plan/phases/trust-before-reach.md)
//
// `PersonalityConfig.outbound_policy.approve_before_send` says an agent may not
// publish without a human's say-so. This is where that becomes true for
// `send_message`: the gate runs inside `executeSendMessage` (O-D3), so nothing
// upstream of the tool — a `before_tool_call` allowlist entry included — can
// route around it.
//
// Declared STRUCTURALLY, never imported. `@ethosagent/outbox` is a sibling
// extension and the layer model (ARCHITECTURE.md §II) keeps extensions from
// importing each other; `ApprovalObservability`
// (`apps/web-api/src/services/approvals.service.ts`) is the precedent for
// writing the shape down instead. The one implementation is `createOutboxGate`
// in `packages/wiring/src/compose-tools.ts`.
// ---------------------------------------------------------------------------

/** One publication, to one destination. What a human will be shown. */
export interface OutboxProposal {
  personalityId: string;
  platform: string;
  /** Chat / channel / user id on `platform`, exactly as the agent named it. */
  target: string;
  /** The text, byte-exact: what a human approves is what goes out. */
  body: string;
  /**
   * The bot this turn speaks as on `platform`, when the lane names one
   * (`laneSenderBotKey` above). A preference, not the answer — which bot sends
   * is resolved at propose time, inside the gate (O-T4), because the
   * personality's bindings are not something a tool package can see.
   */
  laneBotKey?: string;
  /** The lane this proposal came from, for the queued item's provenance. */
  sessionKey?: string;
}

/**
 * What queueing answered.
 *
 * A refusal — no bot on this platform speaks for the personality, or several do
 * and this turn names none — comes back as a value rather than a throw, because
 * it is the agent's to read and repair.
 */
export type OutboxProposalResult =
  | { ok: true; itemId: string; revision: number }
  | { ok: false; error: string };

export interface OutboxGate {
  /**
   * Does `outbound_policy` gate an agent-initiated send by this personality to
   * this platform? True when `approve_before_send` is on and `channels` is
   * absent or names `platform`.
   */
  gates(personalityId: string, platform: string): boolean;

  /**
   * The operator's own chat on `platform`
   * (`channel_filter.<platform>.ownerUserId`), or `undefined` when the
   * deployment configured none. Sending to the person who approves is not
   * publishing, so that destination is exempt.
   */
  ownerTarget(platform: string): string | undefined;

  /** Queue the publication for a human. Never sends. */
  propose(proposal: OutboxProposal): Promise<OutboxProposalResult>;
}

export interface MessagingToolsOptions {
  send: MessagingSendFn;
  getAllowedTargets?: (personalityId?: string) => string[] | null;
  /**
   * The approval outbox. Supplied by every root that can reach a channel —
   * `ethos gateway start` and `ethos boot` (`createOutboxRuntime`) and
   * `ethos serve` (`createOutboxProposalSide`), both in
   * `apps/ethos/src/lib/outbox-wiring.ts` — and threaded down through
   * `ComposeToolsDeps.outbox`, pinned by
   * `apps/ethos/src/__tests__/outbox-gate-live.test.ts`.
   *
   * Absent on `chat`, `cron`, `mcp`, `batch`, `eval`, `acp` and `bench`. None
   * of them installs `send`, so the call below fails with wiring's default
   * "Gateway not active" error and nothing publishes, gated or not; that test
   * fails if one of them gains a send path. Where absent, the tool behaves
   * exactly as it did before O-T3 (pinned by "sends exactly as today when no
   * outbox is wired" in `src/__tests__/outbox-gate.test.ts`).
   */
  outbox?: OutboxGate;
}

/**
 * The bot this turn is speaking as, when it can send on `targetPlatform` at all.
 *
 * A channel turn runs in a lane keyed `${platform}:${botKey}:${chatId}`
 * (CLAUDE.md, "Channel adapter contract"), so the lane itself names the sender.
 * Reading it back is what binds an outbound `send_message` to the bot whose
 * conversation produced it instead of to whichever adapter registered first for
 * the platform — the failure B-T4 (plan/phases/trust-before-reach.md) closes.
 *
 * `undefined` when this turn's identity says nothing about `targetPlatform`:
 *
 *  - a CLI or web turn — its session key carries no botKey segment;
 *  - a turn on a DIFFERENT platform — a Telegram bot's key is not a Slack
 *    sender, and Slack has its own bots to choose between.
 *
 * `undefined` is not permission to fall back: the send path resolves it as
 * "no bot named", which is a refusal wherever the platform has more than one.
 * See `Gateway.sendAsBot`. The lane-key parse is `laneKeyBotKey` in
 * `@ethosagent/core` — the gateway's own lane bookkeeping decodes through the
 * same function.
 */
export function laneSenderBotKey(
  ctx: { platform?: string; sessionKey?: string },
  targetPlatform: string,
): string | undefined {
  if (!ctx.sessionKey || ctx.platform !== targetPlatform) return undefined;
  return laneKeyBotKey(ctx.sessionKey);
}

/**
 * The operator messaging allowlist check, or `undefined` when `platform:target`
 * may be sent to. `getAllowedTargets` absent, or answering `null`, means no
 * allowlist applies. The one owner of this rule: `send_message` below and
 * `watcher_create`'s `deliver` (`createWatcherTools` in
 * `@ethosagent/tools-watchers`, S5) both call it, so a watcher cannot deliver
 * where the personality could not `send_message`.
 */
export function messagingTargetRefusal(
  getAllowedTargets: MessagingToolsOptions['getAllowedTargets'],
  personalityId: string | undefined,
  platform: string,
  target: string,
): string | undefined {
  if (!getAllowedTargets) return undefined;
  const allowed = getAllowedTargets(personalityId);
  if (allowed === null) return undefined;
  const targetKey = `${platform}:${target}`;
  if (allowed.includes(targetKey) || allowed.includes('*')) return undefined;
  return `Target "${targetKey}" is not in the personality's allowed messaging targets. Allowed: ${allowed.join(', ') || 'none'}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMessagingTools(opts: MessagingToolsOptions): Tool[] {
  return [makeSendMessage(opts)];
}

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

function makeSendMessage(opts: MessagingToolsOptions): Tool {
  return {
    name: 'send_message',
    description:
      'Send a message to a configured channel — Slack, Telegram, Discord, WhatsApp, or email. ' +
      'Use this whenever the user asks you to post / send / forward / relay something to another channel; ' +
      'do not refuse for permission reasons unless the tool itself returns an error. ' +
      'If the target is outside the operator-configured allowlist the call fails with a clear message that you should surface verbatim.',
    toolset: 'messaging',
    maxResultChars: 1024,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: [...SEND_MESSAGE_PLATFORMS],
          description: 'Target platform',
        },
        target: {
          type: 'string',
          description:
            'Target identifier (channel ID, chat ID, user ID, WhatsApp JID, or email address)',
        },
        body: {
          type: 'string',
          description: 'Message content (supports markdown on platforms that allow it)',
        },
      },
      required: ['platform', 'target', 'body'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeSendMessage(args as SendMessageArgs, ctx, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SendMessageArgs {
  platform: string;
  target: string;
  body: string;
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

async function executeSendMessage(
  args: SendMessageArgs,
  ctx: ToolContext,
  opts: MessagingToolsOptions,
): Promise<ToolResult> {
  const { platform, target, body } = args;

  if (!platform || !target || !body) {
    return { ok: false, error: 'platform, target, and body are required', code: 'input_invalid' };
  }

  if (!(SEND_MESSAGE_PLATFORMS as readonly string[]).includes(platform)) {
    return {
      ok: false,
      error: `Unknown platform "${platform}". Supported platforms: ${SEND_MESSAGE_PLATFORMS.join(', ')}.`,
      code: 'input_invalid',
    };
  }

  // Check allowed targets.
  const notAllowed = messagingTargetRefusal(
    opts.getAllowedTargets,
    ctx.personalityId,
    platform,
    target,
  );
  if (notAllowed) return { ok: false, error: notAllowed, code: 'input_invalid' };

  // The approval gate, AFTER the allowlist on purpose (O-D3): approval must
  // never widen the destinations the operator allowed, so a target outside the
  // allowlist is refused above rather than queued for a human who could then
  // approve it. Pinned by "refuses a target outside the operator allowlist
  // before it can be queued" in `src/__tests__/outbox-gate.test.ts`.
  //
  // Dry runs and replays never arrive here at all: `executeParallel`
  // (`packages/core/src/tool-registry.ts`) returns `synthesizeDryRunResult`
  // without calling `execute` (X-D6).
  const queued = await gateSend(args, ctx, opts);
  if (queued) return queued;

  try {
    const result = await opts.send(platform, target, body, laneSenderBotKey(ctx, platform));
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Send failed', code: 'execution_failed' };
    }
    return { ok: true, value: `Message sent to ${platform}:${target}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Queue the send instead of performing it, when the personality's
 * `outbound_policy` says a human approves its publications first.
 *
 * Returns the tool's whole answer when the send was gated — the caller must
 * return it and never reach `opts.send`. `undefined` means "not gated, carry
 * on", and is the answer for every ungated personality and both exempt
 * destinations:
 *
 *  - the turn's own chat (`${platform}:${target}` === `ctx.origin`) — that is
 *    the conversation, and an ordinary reply would land there anyway;
 *  - the operator's own chat (`gate.ownerTarget(platform)`) — telling the
 *    person who approves is not publishing.
 *
 * A gate that throws refuses the send. Falling through to `opts.send` because
 * the queue was unreachable would publish exactly the text the policy exists to
 * hold back.
 */
async function gateSend(
  args: SendMessageArgs,
  ctx: ToolContext,
  opts: MessagingToolsOptions,
): Promise<ToolResult | undefined> {
  const gate = opts.outbox;
  const personalityId = ctx.personalityId;
  if (!gate || !personalityId) return undefined;

  let gated: boolean;
  try {
    gated = gate.gates(personalityId, args.platform);
  } catch (err) {
    return outboxUnavailable(err);
  }
  if (!gated) return undefined;

  const { platform, target, body } = args;
  if (ctx.origin !== undefined && `${platform}:${target}` === ctx.origin) return undefined;

  try {
    if (target === gate.ownerTarget(platform)) return undefined;
  } catch (err) {
    return outboxUnavailable(err);
  }

  let proposal: OutboxProposalResult;
  try {
    proposal = await gate.propose({
      personalityId,
      platform,
      target,
      body,
      laneBotKey: laneSenderBotKey(ctx, platform),
      sessionKey: ctx.sessionKey,
    });
  } catch (err) {
    return outboxUnavailable(err);
  }

  if (!proposal.ok) {
    return { ok: false, error: proposal.error, code: 'execution_failed' };
  }

  // The wording is the contract with the agent: a queued publication has NOT
  // been sent, and reporting it as sent is the one failure this whole part
  // exists to prevent (plan/phases/trust-before-reach.md, O-D1).
  return {
    ok: true,
    value:
      `Queued for approval (${proposal.itemId}, revision ${proposal.revision}). NOT sent. ` +
      `Nothing reached ${platform}:${target} — a human has to approve it first, ` +
      `so do not tell anyone it was sent.`,
  };
}

function outboxUnavailable(err: unknown): ToolResult {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error:
      'This personality needs approval before it can publish, and the approval outbox ' +
      `could not be reached: ${detail}. Nothing was sent.`,
    code: 'execution_failed',
  };
}
