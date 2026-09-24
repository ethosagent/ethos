// The fail-closed approval gates for loops where no approval prompt can be
// shown. Two gates, because the two cases differ in who drives the turn:
//
//   - `wireUnattendedApprovalGate` — nobody drives it. Registered by
//     `runGatewayStart` (apps/ethos/src/commands/gateway.ts) on the gateway's
//     systemLoop (cron, dreams, watcher wakes, call capture, SIP-inbound).
//     This is the ONLY gate that honours the D12 opt-in (`approvalMode: off`
//     + `allowUnattendedDangerousTools`): the loop runs trusted local
//     automation. `ethos mcp serve` (M-D10) builds the same shape through
//     `createUnattendedApprovalGate` with its own rejection text.
//   - `createNoApprovalSurfaceGate` — a REMOTE SENDER drives it, on a chat
//     surface that cannot show an approval card. Registered by
//     `wireApprovalFlow` (gateway.ts), the one call every bot-loop host makes
//     (`ethos gateway start`; `ethos boot`'s `registerBotLive` for cold boot,
//     live hot-add, webhook-route bots and a bot replaced on config reload):
//     on every bot loop with no approval-capable adapter (WhatsApp, Email, a
//     `webhooks.<hookId>` route bot), and as `createSlackApprovalHook`'s
//     `withoutSurface` for a card-less turn on a card-capable bot's loop.
//     It never takes the D12 opt-in: auto-approving a call a remote sender
//     asked for is what `createDangerPredicate`'s capability gate forbids,
//     and `validateUnsafeCombinations` (extensions/personalities) cannot see a
//     personality with no `platform:` bound to such a bot in gateway config.
//
// Pinned by `__tests__/unattended-approval-gate.test.ts`,
// `commands/__tests__/approval-flow-unattended.test.ts` and
// `commands/__tests__/gateway-unattended-gate-wiring.test.ts`.
//
// Every other approval surface has somebody to ask — the web modal, the Slack,
// Telegram or Discord card. Here there is no way to ask, and both
// alternatives to refusing are wrong: prompting hangs the call forever, and
// letting it through runs exactly the calls the operator wanted to be asked
// about.

import type {
  BeforeToolCallPayload,
  HookRegistry,
  LLMProvider,
  PersonalityConfig,
  PersonalityRegistry,
} from '@ethosagent/types';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createApprovalDangerPredicate,
  type DangerPredicate,
  SMART_MODE_CONSEQUENTIAL_TOOLS,
} from '@ethosagent/wiring';

/**
 * Turn an approval danger predicate into a `before_tool_call` handler that
 * REJECTS rather than prompts. `reject` renders the refusal text so each
 * surface can say why in its own words, and the agent can tell its caller
 * instead of retrying.
 *
 * Under `approvalMode: 'smart'` the reviewer still runs inside the predicate:
 * a call it approves returns no reason and never reaches the rejection.
 *
 * Registering this also satisfies core's `createApprovalPostureGuard`
 * (`packages/core/src/agent-loop/approval-posture.ts`), which throws at the
 * first tool dispatch when a `gated` loop has nothing registered behind its
 * `before_tool_call` fire site.
 */
export function createUnattendedApprovalGate(
  danger: DangerPredicate,
  reject: (toolName: string, reason: string) => string,
): (payload: BeforeToolCallPayload) => Promise<{ error?: string }> {
  return async (payload) => {
    const reason = await danger(payload);
    if (!reason) return {};
    return { error: reject(payload.toolName, reason) };
  };
}

/** What the agent is told when a flagged call is refused on the systemLoop. */
export function unattendedApprovalRejection(toolName: string, reason: string): string {
  return `no human is present to approve ${toolName} (${reason})`;
}

export interface WireUnattendedApprovalGateOptions {
  /** The registry the loop's personalities are resolved against. */
  personalities: PersonalityRegistry;
  /** Re-read `personalities` from disk before a call is judged, so an edited
   *  `approvalMode` is honoured on the next unattended call. A failed reload
   *  serves last-good. */
  reload?: () => Promise<unknown>;
  getProvider: () => Promise<LLMProvider>;
  model: string;
  /** `EthosConfig.allowUnattendedDangerousTools` — the operator's opt-in that
   *  lets a personality's `approvalMode: 'off'` auto-approve flagged tools on
   *  this loop. Unset → `off` is treated as `manual`, so flagged calls refuse. */
  allowUnattendedDangerousTools: boolean;
}

/**
 * Register the unattended gate on `hooks` — the gateway systemLoop's
 * registry. Uses the same predicate every approval surface uses
 * (`createApprovalDangerPredicate`), so `APPROVAL_SURFACE_ALWAYS_ASK`, the
 * smart reviewer, and the spoken-confirmation wrapper (`withSpokenConfirmation`
 * refuses a `voiceOrigin: far_end` request for a consequential tool) all
 * apply. Deny rules and hardline commands are not this gate's job: core's
 * `enforceBeforeToolCall` and `createTerminalGuardHook` refuse those first.
 * Pinned by `__tests__/unattended-approval-gate.test.ts`.
 */
export function wireUnattendedApprovalGate(
  hooks: HookRegistry,
  opts: WireUnattendedApprovalGateOptions,
): () => void {
  const danger = createApprovalDangerPredicate({
    hooks: [hooks],
    personalities: opts.personalities,
    getProvider: opts.getProvider,
    model: opts.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    allowAutoApproveDangerousTools: opts.allowUnattendedDangerousTools,
  });
  const { reload } = opts;
  const judged: DangerPredicate = reload
    ? async (payload) => {
        await reload().catch(() => {});
        return danger(payload);
      }
    : danger;
  return hooks.registerModifying(
    'before_tool_call',
    createUnattendedApprovalGate(judged, unattendedApprovalRejection),
  );
}

/** What the agent is told when a flagged call is refused on a bot turn whose
 *  chat surface cannot show an approval card. A human did send the message,
 *  so the text names the surface, not an absent human. */
export function noApprovalSurfaceRejection(toolName: string, reason: string): string {
  return (
    `${toolName} needs approval, and this chat surface cannot show an approval prompt ` +
    `(${reason}). Use a platform with approval cards (Slack, Telegram, Discord) or the web UI.`
  );
}

export interface NoApprovalSurfaceGateOptions {
  /** The registry the loops' personalities are resolved against. */
  personalities: PersonalityRegistry;
  getProvider: () => Promise<LLMProvider>;
  model: string;
}

/**
 * The `before_tool_call` handler for bot-loop turns with no approval surface
 * (see the file header for its two callers). `hooks` are the registries of
 * the loops it guards — their `session_start` tells the predicate which
 * personality a turn runs.
 *
 * Same predicate as every approval surface (`createApprovalDangerPredicate`
 * with `APPROVAL_SURFACE_ALWAYS_ASK`; the smart reviewer and the
 * spoken-confirmation wrapper apply), and deliberately WITHOUT
 * `allowAutoApproveDangerousTools`: `approvalMode: off` behaves as `manual`
 * here whatever `allowUnattendedDangerousTools` says, so a flagged call is
 * always refused. Deny rules and hardline commands are refused earlier, by
 * core's `enforceBeforeToolCall` and `createTerminalGuardHook`. Pinned by
 * `commands/__tests__/approval-flow-unattended.test.ts`.
 */
export function createNoApprovalSurfaceGate(
  hooks: ReadonlyArray<HookRegistry>,
  opts: NoApprovalSurfaceGateOptions,
): (payload: BeforeToolCallPayload) => Promise<{ error?: string }> {
  const danger = createApprovalDangerPredicate({
    hooks,
    personalities: opts.personalities,
    getProvider: opts.getProvider,
    model: opts.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
  });
  return createUnattendedApprovalGate(danger, noApprovalSurfaceRejection);
}

/**
 * Personalities whose cron jobs can reach a tool the unattended gate refuses —
 * the boot-time warning's content. A personality is listed when it owns at
 * least one prompt job (script and `source: 'system'` jobs run no LLM turn)
 * and its toolset intersects the tools flagged for it: `APPROVAL_SURFACE_ALWAYS_ASK`,
 * plus `SMART_MODE_CONSEQUENTIAL_TOOLS` under `approvalMode: 'smart'` (the
 * reviewer may approve some of those; it may also refuse). A personality on
 * `approvalMode: 'off'` is pre-authorized, and not listed, only when the
 * operator set `allowUnattendedDangerousTools`. No toolset means every tool.
 * `cron` is excluded, matching the cron runner's recursion guard.
 */
export function unattendedCronExposure(opts: {
  jobs: ReadonlyArray<{ personalityId: string; prompt?: string; source?: 'system' | 'user' }>;
  getPersonality: (id: string) => PersonalityConfig | undefined;
  allowUnattendedDangerousTools: boolean;
}): Array<{ personalityId: string; tools: string[] }> {
  const owners = new Set(
    opts.jobs.filter((j) => j.prompt && j.source !== 'system').map((j) => j.personalityId),
  );
  const exposure: Array<{ personalityId: string; tools: string[] }> = [];
  for (const personalityId of [...owners].sort()) {
    const personality = opts.getPersonality(personalityId);
    const mode = personality?.safety?.approvalMode ?? 'manual';
    if (mode === 'off' && opts.allowUnattendedDangerousTools) continue;
    const flagged =
      mode === 'smart'
        ? [...new Set([...APPROVAL_SURFACE_ALWAYS_ASK, ...SMART_MODE_CONSEQUENTIAL_TOOLS])]
        : [...APPROVAL_SURFACE_ALWAYS_ASK];
    const toolset = personality?.toolset?.filter((t) => t !== 'cron');
    const tools = toolset ? flagged.filter((t) => toolset.includes(t)) : flagged;
    if (tools.length > 0) exposure.push({ personalityId, tools: tools.sort() });
  }
  return exposure;
}

/** The warn-level `audit.block` event code for the boot-time exposure report. */
export const UNATTENDED_CRON_EXPOSURE_CODE = 'unattended_gate_cron_exposure';

/**
 * Compute {@link unattendedCronExposure} and, when it is non-empty, record ONE
 * warn-level safety event naming every exposed personality, so an operator
 * sees which cron jobs the unattended gate will refuse before the first one
 * fails. Returns the exposure so the caller can also print it. Fail-open: a
 * throwing sink costs the event, never the boot.
 */
export function reportUnattendedCronExposure(opts: {
  jobs: ReadonlyArray<{ personalityId: string; prompt?: string; source?: 'system' | 'user' }>;
  getPersonality: (id: string) => PersonalityConfig | undefined;
  allowUnattendedDangerousTools: boolean;
  recordSafetyBlock: (event: {
    code: string;
    cause: string;
    details: Record<string, unknown>;
  }) => void;
}): Array<{ personalityId: string; tools: string[] }> {
  const exposure = unattendedCronExposure(opts);
  if (exposure.length === 0) return exposure;
  const cause =
    'cron jobs can reach tools the systemLoop refuses unattended: ' +
    exposure.map((e) => `${e.personalityId} (${e.tools.join(', ')})`).join('; ');
  try {
    opts.recordSafetyBlock({
      code: UNATTENDED_CRON_EXPOSURE_CODE,
      cause,
      details: { personalities: exposure },
    });
  } catch {
    // observability unavailable — the report is fail-open
  }
  return exposure;
}
