import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';
import type { ApprovalsService } from './approvals.service';

// `before_tool_call` hook handler used by the web profile. Replaces the
// blunt CLI/TUI guard hook (`createTerminalGuardHook` from `tools-terminal`)
// — instead of returning a hard `{ error }` for dangerous commands, this
// hook consults the user via the SSE approval flow and proceeds based on
// their decision.
//
// The danger predicate and the hardline check are injected so this file stays
// free of any extension imports. See `@ethosagent/wiring`'s
// `createDangerPredicate` for the default rules (hardline commands + always-ask
// list) and `hardlineReason` for the hardline check.

export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => Promise<DangerReason>;

export interface CreateApprovalHookOptions {
  approvals: ApprovalsService;
  isDangerous: DangerPredicate;
  /**
   * True for a hardline command. `createWebApi` passes
   * `hardlineReason(payload) !== null` from `@ethosagent/wiring`. A hardline
   * call is sent with `hardline: true`, so no lease or stored grant can
   * approve it — only a human, for that one call (`ApprovalsService`).
   * Consulted only for a call `isDangerous` flagged; the default predicate
   * flags every hardline call first.
   */
  isHardline: (payload: BeforeToolCallPayload) => boolean;
}

export function createWebApprovalHook(opts: CreateApprovalHookOptions) {
  return async (payload: BeforeToolCallPayload): Promise<Partial<BeforeToolCallResult> | null> => {
    const reason = await opts.isDangerous(payload);
    if (reason === null) return null;

    const decision = await opts.approvals.requestApproval({
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
      reason,
      ...(opts.isHardline(payload) ? { hardline: true } : {}),
      // A lease binds to the personality running the turn (3b, D3-7).
      ...(payload.personalityId !== undefined ? { personalityId: payload.personalityId } : {}),
    });

    if (decision.decision === 'allow') return null;
    // Relay the SPECIFIC danger reason alongside the decision. `decision.reason`
    // alone is generic ('denied by user', 'approval timed out'), which tells the
    // agent nothing it can act on; the computed reason names what was dangerous.
    return { error: `${decision.reason} — ${reason}` };
  };
}
