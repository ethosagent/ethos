// The approval gate for the operator's own terminal: `ethos chat` (readline and
// TUI), `ethos chat -q`, and every other CLI command that runs turns with
// nobody at a prompt (`gateNonInteractiveLoop`, ./lib/non-interactive-approval.ts:
// `ethos -z`, `batch`, `eval`, `cron`, the judge, `bench`, the MCP console,
// `acp`). Before this, these loops carried only
// the terminal/process guards `composeAllTools` registers on a non-web profile,
// so a call the danger predicate flags either ran unasked (a host-local shell
// tool, `APPROVAL_SURFACE_ALWAYS_ASK`) or was refused with no way to approve it
// (command substitution).
//
// Built from the card path's pieces, not new ones:
//   - `createApprovalDangerPredicate` (packages/wiring/src/approval-seams.ts)
//     decides what is flagged — same modes, same `executionPostureFor`, same
//     `APPROVAL_SURFACE_ALWAYS_ASK` as the web modal and the chat cards.
//   - `createSlackApprovalHook` + `ApprovalCoordinator`
//     (./approval-coordinator.ts) suspend the call, refuse a hardline call
//     before asking, time out (`approvalTimeoutMs`, default 10 min) and write
//     the safety audit row. The surface — a readline line
//     (`attachCliApprovalPrompt`, ./lib/cli-approval-prompt.ts) or the TUI's
//     modal (via `AgentBridge.setApprovalSource`) — only renders and answers.
//   - `markHostApprovalGate` so the terminal/process guards leave an
//     approval-required command (command substitution) to this gate.
//
// `approvalMode: off` keeps what it meant here before this gate existed:
// flagged calls run unasked (the operator configured this personality on their
// own machine, and `validateUnsafeCombinations` in extensions/personalities
// already refuses `off` on a channel-bound personality). Two exceptions, both
// stricter than a plain auto-approve: a hardline call is still refused, and a
// command-substitution call, which the guards refused outright before, is
// asked rather than waved through (`offModeCommandReason` below).
//
// A run nobody can answer (`coordinator: null` — `ethos chat -q`, the commands
// above, a readline
// session on piped stdin, ACP) refuses every flagged call with a reason that
// says so. There is no "allow for this session": the card path the prompt
// reuses has no lease (only the web modal's `ApprovalsService` does), and a
// lease must never cover a hardline call anyway.

import type { BridgeApprovalSource } from '@ethosagent/agent-bridge';
import { redactString } from '@ethosagent/safety-redact';
import type {
  BeforeToolCallPayload,
  BeforeToolCallResult,
  ExecutionPosture,
  HookRegistry,
  LLMProvider,
  PersonalityRegistry,
} from '@ethosagent/types';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  approvalRequiredReason,
  createApprovalDangerPredicate,
  hardlineReason,
  markHostApprovalGate,
  type SmartApproverDecisionSite,
} from '@ethosagent/wiring';
import { type ApprovalCoordinator, createSlackApprovalHook } from './approval-coordinator';

export interface TerminalApprovalGateOptions {
  /** The registry the loop resolves personalities from. */
  personalities: PersonalityRegistry;
  /** Lazy provider handle for `approvalMode: 'smart'`. */
  getProvider: () => Promise<LLMProvider>;
  /** Model the smart reviewer runs on. */
  model: string;
  /** `CreateAgentLoopResult.approverDecision` of the loop's build. */
  decision?: SmartApproverDecisionSite;
  /** `CreateAgentLoopResult.executionPostureFor` of the loop's build. */
  executionPostureFor: (personalityId: string | undefined) => ExecutionPosture | undefined;
  /**
   * The coordinator a person answers through, or `null` when nobody can be
   * asked on this run — every flagged call is then refused.
   */
  coordinator: ApprovalCoordinator | null;
  /** Why nobody can be asked, for the refusal when `coordinator` is null. */
  nonInteractive: string;
  /** Why a flagged call will be refused anyway, so it is refused without a
   *  prompt — `CreateSlackApprovalHookOptions.refusedAnyway`. */
  refusedAnyway?: (payload: BeforeToolCallPayload) => string | null;
}

/** What the agent is told when a flagged call is refused on a run with no prompt. */
export function terminalNoPromptRejection(
  toolName: string,
  reason: string,
  nonInteractive: string,
): string {
  return (
    `${toolName} needs approval, and ${nonInteractive} (${reason}). ` +
    'Run `ethos chat` in an interactive terminal to be asked, or use the web UI.'
  );
}

/**
 * Register the terminal approval gate on `hooks` and mark the loop
 * (`markHostApprovalGate`). Returns the undo. Register it AFTER the loop is
 * built, so the terminal/process guards `composeAllTools` registered run first.
 */
export function wireTerminalApprovalGate(
  hooks: HookRegistry,
  opts: TerminalApprovalGateOptions,
): () => void {
  const danger = createApprovalDangerPredicate({
    hooks: [hooks],
    personalities: opts.personalities,
    getProvider: opts.getProvider,
    model: opts.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    // `off` runs flagged calls unasked here, as it did before this gate — see
    // the file header. Hardline is still refused: the predicate returns the
    // hardline reason before it reads the mode.
    allowAutoApproveDangerousTools: true,
    ...(opts.decision ? { decision: opts.decision } : {}),
    executionPostureFor: opts.executionPostureFor,
  });
  const isDangerous = async (payload: BeforeToolCallPayload): Promise<string | null> =>
    (await danger(payload)) ?? offModeCommandReason(payload, opts.personalities);

  const refuse = async (
    payload: BeforeToolCallPayload,
  ): Promise<Partial<BeforeToolCallResult> | null> => {
    const hardline = hardlineReason(payload);
    if (hardline) return { error: `Command blocked: ${hardline}. No approval can allow it.` };
    const reason = await isDangerous(payload);
    if (reason === null) return null;
    return { error: terminalNoPromptRejection(payload.toolName, reason, opts.nonInteractive) };
  };

  const coordinator = opts.coordinator;
  const decide =
    coordinator === null
      ? refuse
      : createSlackApprovalHook({
          coordinator,
          isDangerous,
          // One person at one terminal: every turn has the surface, and any
          // answer typed there is theirs (no requester binding).
          resolveApprovalTarget: () => ({}),
          withoutSurface: async (payload) => (await refuse(payload)) ?? {},
          hardlineReason,
          ...(opts.refusedAnyway ? { refusedAnyway: opts.refusedAnyway } : {}),
        });

  const unregister = hooks.registerModifying('before_tool_call', async (payload) => {
    // Fail closed: `fireModifying` swallows a throwing handler, which would let
    // the call through.
    try {
      return await decide(payload);
    } catch (err) {
      return {
        error: `approval check failed (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  });
  const unmark = markHostApprovalGate(hooks);
  return () => {
    unregister();
    unmark();
  };
}

/**
 * Under `approvalMode: off` the predicate auto-approves every non-hardline
 * flag, command substitution included. On these surfaces the guards refused a
 * substitution before this gate existed, so auto-approving it would make `off`
 * looser than it was; it is asked instead. Other modes are left to the
 * predicate (a `smart` reviewer's `approve` stands, as on every surface).
 */
function offModeCommandReason(
  payload: BeforeToolCallPayload,
  personalities: PersonalityRegistry,
): string | null {
  const commandReason = approvalRequiredReason(payload);
  if (commandReason === null || payload.personalityId === undefined) return null;
  const mode = personalities.get(payload.personalityId)?.safety?.approvalMode;
  if (mode !== 'off') return null;
  return `${payload.toolName} requires explicit approval (${commandReason})`;
}

const PREVIEW_MAX_CHARS = 300;

/**
 * The args preview a terminal prompt shows: compact JSON, secrets redacted
 * (`redactString`, @ethosagent/safety-redact), cut at 300 characters.
 */
export function formatApprovalArgsPreview(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = String(args);
  }
  text = redactString(text);
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…` : text;
}

/**
 * Adapt a coordinator to the `BridgeApprovalSource` both terminal surfaces
 * render from: the readline prompt (`attachCliApprovalPrompt`) and the TUI
 * (`AgentBridge.setApprovalSource`). Reason and args are redacted here, so no
 * surface ever holds the raw arguments. `decidedBy` names the surface in the
 * audit row.
 */
export function createTerminalApprovalSource(
  coordinator: ApprovalCoordinator,
  decidedBy: string,
): BridgeApprovalSource {
  return {
    onRequest: (listener) =>
      coordinator.onPending((pending) =>
        listener({
          approvalId: pending.approvalId,
          toolName: pending.toolName,
          reason: redactString(pending.reason ?? `${pending.toolName} requires explicit approval`),
          argsPreview: formatApprovalArgsPreview(pending.args),
        }),
      ),
    onSettled: (listener) => coordinator.onResolved(listener),
    decide: (approvalId, decision) => {
      void (decision === 'allow'
        ? coordinator.approve(approvalId, decidedBy)
        : coordinator.deny(approvalId, decidedBy));
    },
  };
}
