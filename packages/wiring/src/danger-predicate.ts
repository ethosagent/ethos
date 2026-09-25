// Ch.4 — danger predicate for the before_tool_call hook.
//
// Lives in its own file so tests can import it without dragging in
// the full createAgentLoop wiring (which depends on plugin-loader,
// sandbox-docker, etc. and chokes outside the monorepo install).

import {
  checkCommand as checkProcessCommand,
  approvalRequiredReason as processApprovalReason,
} from '@ethosagent/tools-process';
import {
  checkCommand as checkTerminalCommand,
  approvalRequiredReason as terminalApprovalReason,
} from '@ethosagent/tools-terminal';
import type {
  BeforeToolCallPayload,
  ExecutionPosture,
  HookRegistry,
  PersonalityConfig,
} from '@ethosagent/types';

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
  /**
   * The personality `createDangerPredicate` read `approvalMode` from — the
   * SAME resolution, so the approver's decision-site mode and the approval
   * mode can never come from two different personalities (plan
   * decision-provider-personality §7.3). `undefined` when no personality
   * resolved; a per-personality reviewer treats that as "nothing enabled".
   */
  personality?: PersonalityConfig,
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
 * `alwaysAsk` alone — in every mode plus {@link LOCAL_POSTURE_CONSEQUENTIAL_TOOLS}
 * when the turn runs on a host-local posture. An explicit `alwaysAsk` therefore always takes effect, in
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
 * Tools flagged, in every mode, when the turn's personality resolves to a
 * LOCAL execution posture that is not itself a container (S6 / D1(a) and
 * EXE-001, plan openclaw-2026.9.6-gaps).
 *
 * Each of these runs a model-chosen shell string on the HOST, as the Ethos
 * user, with nothing between it and the operator's files but the regex
 * hardline: `terminal` and `process_start` directly, `run_tests` and `lint`
 * through `bash -c` (`makeCommandTool`, extensions/tools-code/src/index.ts).
 * Under a docker posture the container is the boundary and they stay
 * unflagged in `manual`, as before; a `containerized` local posture (Ethos
 * itself runs in a container, `detectContainerized`) is treated the same way.
 *
 * Composition is the same union as {@link SMART_MODE_CONSEQUENTIAL_TOOLS}: it
 * only adds to `alwaysAsk`. Under `off` with the unattended capability
 * (`allowAutoApproveDangerousTools`) they are still auto-approved — that
 * operator opt-in is exactly "run these without asking".
 *
 * The posture comes from {@link CreateDangerPredicateOptions.getExecutionPosture};
 * without it (bare tests) nothing is added. The approval surfaces all supply
 * it (`createApprovalDangerPredicate` requires it,
 * packages/wiring/src/approval-seams.ts).
 */
export const LOCAL_POSTURE_CONSEQUENTIAL_TOOLS: ReadonlyArray<string> = [
  'terminal',
  'process_start',
  'run_tests',
  'lint',
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
 * Passed by every approval-surface entry point: `apps/ethos/src/commands/
 * serve.ts` and `apps/desktop/src/main/serve.ts` (web modal),
 * `apps/ethos/src/commands/gateway.ts` (Slack card), and
 * `wireTerminalApprovalGate` (apps/ethos/src/terminal-approval.ts — the CLI
 * prompt, the TUI modal, and the fail-closed gate on `ethos chat -q`, ACP and
 * the other non-interactive CLI commands, `gateNonInteractiveLoop` in
 * apps/ethos/src/lib/non-interactive-approval.ts).
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
   * `approvalMode: 'smart'`; used alone under `manual` and `off`. In every
   * mode {@link LOCAL_POSTURE_CONSEQUENTIAL_TOOLS} is added on a host-local
   * posture (see {@link CreateDangerPredicateOptions.getExecutionPosture}).
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
   * The execution posture the turn's personality resolves to — the SAME
   * resolution the tools run under (`ExecutionRouting.resolvePosture`,
   * packages/wiring/src/compose-tools.ts). Drives
   * {@link LOCAL_POSTURE_CONSEQUENTIAL_TOOLS}. Absent or `undefined` → no
   * posture-dependent flags.
   */
  getExecutionPosture?: (
    payload: BeforeToolCallPayload,
    personality: PersonalityConfig | undefined,
  ) => ExecutionPosture | undefined;
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
   * **Two production callers pass this flag.** The gateway systemLoop's
   * unattended gate (`wireUnattendedApprovalGate` in
   * `apps/ethos/src/unattended-approval-gate.ts`, registered by
   * `runGatewayStart`, and by `gateCronLoop` in
   * `apps/ethos/src/lib/non-interactive-approval.ts` for `ethos cron
   * run`/`daemon`), and only when the operator sets
   * `allowUnattendedDangerousTools: true` in `config.yaml`. Those loops run
   * cron, dreams and watcher wakes — trusted local automation with nobody
   * to ask. And the operator's own terminal (`wireTerminalApprovalGate` in
   * `apps/ethos/src/terminal-approval.ts`: `ethos chat`, and every CLI
   * command `gateNonInteractiveLoop` gates — `-q`, `-z`, `batch`, `eval`,
   * the judge, `bench`, the MCP console, `acp`), always: `off` there keeps meaning what it meant before
   * those loops had a gate — flagged calls run unasked — except that a
   * command-substitution call is still asked (or refused where nobody can
   * be asked). Every surface a remote sender or a browser can reach — the
   * web modal (`serve.ts`, `apps/desktop/src/main/serve.ts`), the
   * Slack/Telegram card (`wireApprovalFlow` in `gateway.ts`) and the MCP
   * export — omits it, so `off` behaves as `manual` there.
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
 * Tools whose `command` argument is a shell string checked by the terminal
 * guard's `checkCommand`: `terminal` itself, and `run_tests` / `lint`, which
 * hand their `command` to `bash -c` (EXE-001). Read by {@link hardlineReason}
 * and by the non-web guard registration in `composeAllTools`
 * (`createTerminalGuardHook(TERMINAL_CHECKED_TOOLS)`), so the approval path
 * and the hard block cover the same set.
 */
export const TERMINAL_CHECKED_TOOLS: ReadonlyArray<string> = ['terminal', 'run_tests', 'lint'];

/**
 * The hardline reason for a call, or `null` when it is not hardline.
 *
 * Hardline = a {@link TERMINAL_CHECKED_TOOLS} or `process_start` `command`
 * that the blocklist refuses (`checkCommand` in `@ethosagent/tools-terminal`
 * and `@ethosagent/tools-process` respectively — the same checks
 * `createTerminalGuardHook` / `createProcessGuardHook` hard-block with on
 * every non-web profile, `compose-tools.ts`).
 *
 * Used twice: as the danger predicate's first branch, and by the web profile
 * (injected as `isHardline` into `createWebApprovalHook` by `createWebApi`,
 * `apps/web-api/src/index.ts`) so `ApprovalsService` can refuse to let a
 * stored grant or a lease decide a hardline call.
 */
export function hardlineReason(payload: BeforeToolCallPayload): string | null {
  const check = TERMINAL_CHECKED_TOOLS.includes(payload.toolName)
    ? checkTerminalCommand
    : payload.toolName === 'process_start'
      ? checkProcessCommand
      : undefined;
  if (!check) return null;
  const command = shellCommand(payload);
  if (command === null) return null;
  const result = check(command);
  return result.dangerous ? result.reason : null;
}

/**
 * Why a {@link TERMINAL_CHECKED_TOOLS} or `process_start` `command` needs a
 * human's approval though it is not hardline, or `null` — today, command
 * substitution (`approvalRequiredReason` in `@ethosagent/tools-terminal` and
 * `@ethosagent/tools-process`). {@link createDangerPredicate} flags such a call
 * in every approval mode; callers check {@link hardlineReason} first.
 */
export function approvalRequiredReason(payload: BeforeToolCallPayload): string | null {
  const reason = TERMINAL_CHECKED_TOOLS.includes(payload.toolName)
    ? terminalApprovalReason
    : payload.toolName === 'process_start'
      ? processApprovalReason
      : undefined;
  if (!reason) return null;
  const command = shellCommand(payload);
  return command === null ? null : reason(command);
}

function shellCommand(payload: BeforeToolCallPayload): string | null {
  const args = payload.args as { command?: unknown } | null | undefined;
  return typeof args?.command === 'string' && args.command !== '' ? args.command : null;
}

/**
 * Loops whose `before_tool_call` carries a HOST APPROVAL GATE: a hook built on
 * this module's predicate that, for every call the predicate flags, either
 * asks a human or refuses. Marked by the code that registers the gate —
 * `wireApprovalFlow` (apps/ethos/src/commands/gateway.ts: the card hook or the
 * no-surface gate, for every bot), `wireUnattendedApprovalGate`
 * (apps/ethos/src/unattended-approval-gate.ts, the systemLoop) and
 * `wireTerminalApprovalGate` (apps/ethos/src/terminal-approval.ts: `ethos
 * chat` and the non-interactive CLI commands, `gateNonInteractiveLoop` in
 * apps/ethos/src/lib/non-interactive-approval.ts). Read per call by the terminal and
 * process guards `composeAllTools` registers (`approvalGated`), which leave an
 * approval-required command to the gate on a marked loop and refuse it on any
 * other, since nobody could approve it there. An unmarked loop is the
 * fail-closed default.
 * A mark on a registry that is garbage-collected goes with it (WeakSet).
 */
const hostApprovalGated = new WeakSet<HookRegistry>();

/** Record that `hooks` carries a host approval gate. Returns the undo. */
export function markHostApprovalGate(hooks: HookRegistry): () => void {
  hostApprovalGated.add(hooks);
  return () => {
    hostApprovalGated.delete(hooks);
  };
}

/** Whether `hooks` carries a host approval gate ({@link markHostApprovalGate}). */
export function hasHostApprovalGate(hooks: HookRegistry): boolean {
  return hostApprovalGated.has(hooks);
}

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
 *   1. Hardline command ({@link hardlineReason}) → return the reason, in
 *      every mode: `off` and a `smart` reviewer `approve` never skip it.
 *      What that reason then MEANS depends on the surface:
 *        - Every non-web profile also registers `createTerminalGuardHook` /
 *          `createProcessGuardHook` (`compose-tools.ts`), which refuse the
 *          call outright — no one can approve it.
 *        - The web profile registers neither guard; its approval hook is the
 *          only gate, and a human MAY approve one hardline call there (the
 *          web profile's "ask, don't block" design, `approval-hook.ts`).
 *          What is refused is anything standing in for that human:
 *          `ApprovalsService.requestApproval` skips both the lease and the
 *          allowlist for a hardline call, and `ApprovalsService.approve`
 *          stores nothing for one whatever scope was chosen. Pinned by
 *          `apps/web-api/src/__tests__/services/approvals-hardline.test.ts`.
 *   2. Flagged tool / non-hardline danger → consult approvalMode. The flag set
 *      is `alwaysAsk` under manual and off, and
 *      `alwaysAsk ∪ SMART_MODE_CONSEQUENTIAL_TOOLS` under smart; in every mode
 *      it also takes {@link LOCAL_POSTURE_CONSEQUENTIAL_TOOLS} when the turn
 *      runs on a non-containerized local posture, and any call with an
 *      {@link approvalRequiredReason} (command substitution), on any posture:
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
  // Resolved only for a tool on the list, so every other call pays nothing.
  const onHostShell = (
    payload: BeforeToolCallPayload,
    personality: PersonalityConfig | undefined,
  ): boolean => {
    if (!LOCAL_POSTURE_CONSEQUENTIAL_TOOLS.includes(payload.toolName)) return false;
    const posture = opts.getExecutionPosture?.(payload, personality);
    return posture?.backend === 'local' && posture.containerized !== true;
  };
  return async (payload) => {
    // Hardline first, in every mode — see the resolution order above for what
    // enforces it on each surface.
    const hardline = hardlineReason(payload);
    if (hardline) return hardline;

    // Resolved ONCE: the approval mode below and the smart reviewer's
    // per-personality decision site both read this object.
    const personality = opts.getPersonality?.(payload);
    const safety = personality?.safety;

    // Non-hardline danger. The mode is resolved first because it selects the
    // flag set: `smart` adds the built-in consequential-tool list on top of
    // `alwaysAsk`, `manual` / `off` see `alwaysAsk` alone; a host-local posture
    // adds the shell tools in every mode (`onHostShell`).
    // Future: per-tool risk classifiers (sql_execute, kubectl, etc.)
    // would also produce non-hardline reasons that route through here.
    const mode = safety?.approvalMode ?? 'manual';
    const flagged = mode === 'smart' ? smartAlwaysAsk : alwaysAsk;
    // An approval-required command (command substitution) is flagged in every
    // mode, whatever the tool's own flag status, and its reason is named.
    const commandReason = approvalRequiredReason(payload);
    let dangerReason: string | null = null;
    if (commandReason) {
      dangerReason = `${payload.toolName} requires explicit approval (${commandReason})`;
    } else if (flagged.has(payload.toolName) || onHostShell(payload, personality)) {
      dangerReason = `${payload.toolName} requires explicit approval`;
    }
    if (!dangerReason) return null;

    if (mode === 'off' && opts.allowAutoApproveDangerousTools === true) return null;
    if (mode === 'smart' && opts.smartApprove) {
      const verdict = await opts.smartApprove(payload, dangerReason, personality);
      if (verdict.decision === 'approve') return null;
      // A reviewer `deny` carries a concrete, actionable reason — surface it
      // so the agent can course-correct. `ask` is undecided, so it keeps the
      // generic danger reason and routes to the normal approval flow.
      return verdict.decision === 'deny' ? `denied by reviewer: ${verdict.reason}` : dangerReason;
    }
    return dangerReason;
  };
}
