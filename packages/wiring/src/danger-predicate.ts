// Ch.4 — danger predicate for the before_tool_call hook.
//
// Lives in its own file so tests can import it without dragging in
// the full createAgentLoop wiring (which depends on plugin-loader,
// sandbox-docker, etc. and chokes outside the monorepo install).

import { checkCommand } from '@ethosagent/tools-terminal';
import type { BeforeToolCallPayload, PersonalityConfig } from '@ethosagent/types';

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => Promise<DangerReason>;

/**
 * Verdict returned by a smart-approval reviewer.
 *
 *   `approve` — low residual risk; the call proceeds with no prompt.
 *   `deny`    — the call must not run; the reason surfaces to the agent.
 *   `ask`     — undecided; falls through to the normal approval flow.
 *
 * `ask` is the fail-closed default: any error, timeout, or unparseable
 * reviewer response maps to `ask`, never to `approve`.
 */
export interface SmartVerdict {
  decision: 'approve' | 'deny' | 'ask';
  reason: string;
}

/**
 * Ch.4b — auxiliary classifier hook. When `approvalMode: smart` is set,
 * the danger predicate consults this callback (typically a cheap-model
 * call) for a `dangerous` classification: low residual risk →
 * auto-approve, high residual risk → leave the dangerous flag in place
 * so the approval modal still fires. `approve` is the only fast-path;
 * any uncertainty falls through to the approval flow.
 */
export type SmartApprovalCallback = (
  payload: BeforeToolCallPayload,
  reason: string,
) => Promise<SmartVerdict>;

/**
 * Tools flagged for review **under `approvalMode: 'smart'` only**.
 *
 * Why smart-only: a personality that opts into `smart` is explicitly asking for
 * an LLM to judge its consequential calls. Before this list existed the only
 * non-hardline danger source was a caller-supplied `alwaysAsk`, which at the
 * time no production caller passed — so `dangerReason` was always `null` under
 * `smart` and the reviewer was structurally unreachable. Confining the list to
 * `smart` keeps `manual` and `off` at their previous behaviour: their flag set
 * stays exactly `opts.alwaysAsk`, which the approval-surface entry points now
 * populate with {@link APPROVAL_SURFACE_ALWAYS_ASK}.
 *
 * **Composition: union, not override.** Under `smart` the effective flag set is
 * `alwaysAsk ∪ SMART_MODE_CONSEQUENTIAL_TOOLS`; under `manual` / `off` it is
 * `alwaysAsk` alone. An explicit `alwaysAsk` therefore always takes effect, in
 * every mode — this list can only add to it, never replace or subtract from it.
 * That matches the module's law that modes only make things stricter.
 *
 * **Scope: mutating-or-executing only.** Read-only tools (`read_file`,
 * `search_files`, `list_*`, `web_search`, the `browser_*` readers) are
 * deliberately absent: flagging a lookup would cost an LLM round-trip per read
 * for no safety benefit. `run_code` is also absent — it executes inside an
 * isolated container with no network, no `fs_reach`, and a memory cap, so the
 * sandbox is already the containment. `process_stop` / `process_list` /
 * `process_logs` observe or wind down work this list already gated at spawn.
 *
 * **Cost.** `createSmartApprover` caches verdicts on
 * `sha256(toolName + canonicalized args)`, so a repeated identical call is
 * served from cache and never re-reviewed. Worst case under `smart` is
 * therefore one reviewer call per *distinct* consequential call — a typical
 * turn that writes two files and runs one command costs three, and a retry loop
 * re-issuing the same command costs zero more.
 *
 * Not a frozen contract: it is a default. Callers that want a different set
 * pass `alwaysAsk`, and a personality that wants a specific call refused
 * outright uses `safety.denyRules`, which core enforces before any hook runs
 * (`enforceBeforeToolCall`, `packages/core/src/agent-loop/stages/per-call-enforcement.ts`).
 */
export const SMART_MODE_CONSEQUENTIAL_TOOLS: ReadonlyArray<string> = [
  // Shell execution on the host or execution backend — the widest-reach tool in
  // the registry, and the only path to file deletion or move (no dedicated tool
  // exists for either). The hardline check still short-circuits ahead of the
  // reviewer for the commands it refuses outright.
  'terminal',
  // Creates or overwrites a file; an overwrite discards the prior content with
  // no tool-layer undo.
  'write_file',
  // In-place edit of existing file content — same irreversibility as
  // `write_file`, at finer granularity.
  'patch_file',
  // Spawns a background process that outlives the turn, so nothing later in the
  // turn can be relied on to clean it up.
  'process_start',
];

/**
 * Tools every entry point WITH an approval surface flags via `alwaysAsk`, in
 * every mode — not just `smart`.
 *
 * The two `skills_pending_*` entries promote or discard a proposed skill, and
 * the agent is also what
 * proposes skills: left ungated it can approve its own proposal into the live
 * library, which is a self-authorising write to the skill set. `requiresApproval:
 * true` on the tool does NOT achieve this — that flag is declarative only (see
 * `tool-processing.ts`, which emits `tool_approval_required` and then runs the
 * tool regardless). `alwaysAsk` is the mechanism that actually prompts.
 *
 * Passed by the three approval-surface entry points: `apps/ethos/src/commands/
 * serve.ts` and `apps/desktop/src/main/serve.ts` (web modal) and
 * `apps/ethos/src/commands/gateway.ts` (Slack card). CLI and TUI deliberately do
 * NOT pass it: they have no approval flow at all — only the synchronous,
 * hard-blocking `createTerminalGuardHook` — so flagging a tool there would
 * change nothing. Both tools' `description` strings say so, so the model is not
 * told a prompt exists where none does.
 *
 * `call` (outbound telephony) is listed for a different reason: the gate
 * PREDATES the capability, deliberately. The tool self-reports unavailable
 * until a SIP trunk is wired, so listing it changes nothing today — and when
 * the trunk lands, dialling someone's phone is already gated instead of
 * depending on whoever wires it to remember. An outbound call is the least
 * reversible call in the registry: it happens on another person's device, in
 * real time, in the operator's name.
 */
export const APPROVAL_SURFACE_ALWAYS_ASK: ReadonlyArray<string> = [
  'skills_pending_approve',
  'skills_pending_reject',
  'call',
];

export interface CreateDangerPredicateOptions {
  /**
   * Tools that always require approval, in every mode. Unioned with
   * {@link SMART_MODE_CONSEQUENTIAL_TOOLS} when the resolved personality is on
   * `approvalMode: 'smart'`; used alone under `manual` and `off`.
   *
   * Every entry point that has an approval surface passes at least
   * {@link APPROVAL_SURFACE_ALWAYS_ASK}.
   */
  alwaysAsk?: ReadonlyArray<string>;
  /** Resolves the active personality config for a given session. The
   *  predicate uses it to read `safety.approvalMode`. Optional — when
   *  unset, every personality falls through to the legacy `manual`
   *  default behavior (return reason for terminal hardline, null
   *  otherwise). */
  getPersonality?: (payload: BeforeToolCallPayload) => PersonalityConfig | undefined;
  /** Smart-mode callback (see SmartApprovalCallback above). */
  smartApprove?: SmartApprovalCallback;
  /**
   * Capability gate for `approvalMode: 'off'`. Without this set to
   * true, the predicate treats `off` as `manual` — i.e. it will NOT
   * auto-approve any dangerous tool, even when the personality config
   * declares `off`. The personality-registry load-time check rejects
   * `off` + channel ingress, but this flag is the predicate-local
   * guarantee that survives any future caller bypassing the registry
   * (Codex flagged the prior cross-module-only invariant as security-
   * rot shaped).
   *
   * **Exactly one production caller passes this flag:** the gateway
   * systemLoop's unattended gate (`wireUnattendedApprovalGate` in
   * `apps/ethos/src/unattended-approval-gate.ts`, registered by
   * `runGatewayStart`), and only when the operator sets
   * `allowUnattendedDangerousTools: true` in `config.yaml`. That loop runs
   * cron, dreams and watcher wakes — trusted local automation with nobody
   * to ask. Every surface with a human — the web modal (`serve.ts`,
   * `apps/desktop/src/main/serve.ts`), the Slack/Telegram card
   * (`wireApprovalFlow` in `gateway.ts`) and the MCP export — omits it, so
   * `off` behaves as `manual` there. CLI / TUI use the synchronous
   * `createTerminalGuardHook` (hard-block, no approval flow).
   *
   * The capability gate stays the API contract that prevents any other
   * caller from accidentally auto-approving dangerous tools.
   */
  allowAutoApproveDangerousTools?: boolean;
}

/**
 * Canonical args form, re-exported for `createSmartApprover`'s verdict cache.
 * It lives in core (`packages/core/src/agent-loop/deny-rules.ts`) beside the
 * deny-rule matcher that uses the same form.
 */
export { canonicalizeArgs } from '@ethosagent/core';

/**
 * Default danger predicate.
 *
 * **Deny rules are NOT evaluated here.** `safety.denyRules` is the hard floor
 * and is enforced in core, by `enforceBeforeToolCall`
 * (`packages/core/src/agent-loop/stages/per-call-enforcement.ts`), before any
 * `before_tool_call` hook — and therefore before this predicate — runs. A
 * matching call is refused outright on every loop, under every mode, and never
 * reaches an approval surface. Pinned by
 * `packages/core/src/agent-loop/__tests__/deny-rule-gate.test.ts`.
 *
 * Resolution order:
 *   1. Hardline command  → return reason (Ch.4a — non-overridable; the
 *                          terminalGuardHook hard-blocks separately so
 *                          this is belt + suspenders).
 *   2. Flagged tool / non-hardline danger → consult approvalMode. The flag set
 *      is `alwaysAsk` under manual and off, and
 *      `alwaysAsk ∪ SMART_MODE_CONSEQUENTIAL_TOOLS` under smart:
 *        manual (default) → return the reason (drives the modal).
 *        off              → return null (auto-approve — hardline still
 *                           hard-blocks separately).
 *        smart            → consult `smartApprove` callback. `approve`
 *                           auto-approves; `deny` surfaces the reviewer's
 *                           specific reason; `ask` surfaces the generic
 *                           danger reason. Without the callback wired,
 *                           smart degrades to manual.
 *
 * The plan reserves `off` for trusted local automation (cron, batch);
 * the load-time check in personality registry rejects `off` + channel
 * ingress so a remote sender can never drive an auto-approved
 * dangerous tool.
 */
export function createDangerPredicate(opts: CreateDangerPredicateOptions = {}): DangerPredicate {
  const alwaysAsk = new Set(opts.alwaysAsk ?? []);
  // Built once; `smart` is the only mode that sees it (see the const's docs).
  const smartAlwaysAsk = new Set([...alwaysAsk, ...SMART_MODE_CONSEQUENTIAL_TOOLS]);
  return async (payload) => {
    // Hardline command first — non-overridable in every mode.
    let hardlineReason: string | null = null;
    if (payload.toolName === 'terminal') {
      const args = payload.args as { command?: string } | null | undefined;
      if (args?.command) {
        const result = checkCommand(args.command);
        if (result.dangerous) hardlineReason = result.reason;
      }
    }
    if (hardlineReason) return hardlineReason;

    const safety = opts.getPersonality?.(payload)?.safety;

    // Non-hardline danger. The mode is resolved first because it selects the
    // flag set: `smart` adds the built-in consequential-tool list on top of
    // `alwaysAsk`, `manual` / `off` see `alwaysAsk` alone.
    // Future: per-tool risk classifiers (sql_execute, kubectl, etc.)
    // would also produce non-hardline reasons that route through here.
    const mode = safety?.approvalMode ?? 'manual';
    const flagged = mode === 'smart' ? smartAlwaysAsk : alwaysAsk;
    let dangerReason: string | null = null;
    if (flagged.has(payload.toolName)) {
      dangerReason = `${payload.toolName} requires explicit approval`;
    }
    if (!dangerReason) return null;

    if (mode === 'off' && opts.allowAutoApproveDangerousTools === true) return null;
    if (mode === 'smart' && opts.smartApprove) {
      const verdict = await opts.smartApprove(payload, dangerReason);
      if (verdict.decision === 'approve') return null;
      // A reviewer `deny` carries a concrete, actionable reason — surface it
      // so the agent can course-correct. `ask` is undecided, so it keeps the
      // generic danger reason and routes to the normal approval flow.
      return verdict.decision === 'deny' ? `denied by reviewer: ${verdict.reason}` : dangerReason;
    }
    return dangerReason;
  };
}
