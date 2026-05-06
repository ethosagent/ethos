// Ch.4 — danger predicate for the before_tool_call hook.
//
// Lives in its own file so tests can import it without dragging in
// the full createAgentLoop wiring (which depends on plugin-loader,
// sandbox-docker, etc. and chokes outside the monorepo install).

import { checkCommand } from '@ethosagent/tools-terminal';
import type { BeforeToolCallPayload, PersonalityConfig } from '@ethosagent/types';

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => DangerReason;

/**
 * Ch.4b — auxiliary classifier hook. When `approvalMode: smart` is set,
 * the danger predicate consults this callback (typically a Haiku call)
 * for a `dangerous` classification: low residual risk → auto-approve,
 * high residual risk → leave the dangerous flag in place so the
 * approval modal still fires. Synchronous return is a v1 simplification
 * — production smart mode would be async, but the danger-predicate
 * callsites are sync. Treat `auto-approve` as the only fast-path; any
 * uncertainty falls through to the approval flow.
 */
export type SmartApprovalCallback = (payload: BeforeToolCallPayload, reason: string) => boolean;

export interface CreateDangerPredicateOptions {
  alwaysAsk?: ReadonlyArray<string>;
  /** Resolves the active personality config for a given session. The
   *  predicate uses it to read `safety.approvalMode`. Optional — when
   *  unset, every personality falls through to the legacy `manual`
   *  default behavior (return reason for terminal hardline, null
   *  otherwise). */
  getPersonality?: (payload: BeforeToolCallPayload) => PersonalityConfig | undefined;
  /** Smart-mode callback (see SmartApprovalCallback above). */
  smartApprove?: SmartApprovalCallback;
}

/**
 * Default danger predicate.
 *
 * Resolution order:
 *   1. Hardline command  → return reason (Ch.4a — non-overridable; the
 *                          terminalGuardHook hard-blocks separately so
 *                          this is belt + suspenders).
 *   2. Always-ask / non-hardline danger → consult approvalMode:
 *        manual (default) → return the reason (drives the modal).
 *        off              → return null (auto-approve — hardline still
 *                           hard-blocks separately).
 *        smart            → consult `smartApprove` callback. true =
 *                           auto-approve, false = surface the reason.
 *                           Without the callback wired, smart degrades
 *                           to manual.
 *
 * The plan reserves `off` for trusted local automation (cron, batch);
 * the load-time check in personality registry rejects `off` + channel
 * ingress so a remote sender can never drive an auto-approved
 * dangerous tool.
 */
export function createDangerPredicate(opts: CreateDangerPredicateOptions = {}): DangerPredicate {
  const alwaysAsk = new Set(opts.alwaysAsk ?? []);
  return (payload) => {
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

    // Non-hardline danger — alwaysAsk is the only such source today.
    // Future: per-tool risk classifiers (sql_execute, kubectl, etc.)
    // would also produce non-hardline reasons that route through here.
    let dangerReason: string | null = null;
    if (alwaysAsk.has(payload.toolName)) {
      dangerReason = `${payload.toolName} requires explicit approval`;
    }
    if (!dangerReason) return null;

    const mode = opts.getPersonality?.(payload)?.safety?.approvalMode ?? 'manual';
    if (mode === 'off') return null;
    if (mode === 'smart' && opts.smartApprove) {
      const approved = opts.smartApprove(payload, dangerReason);
      return approved ? null : dangerReason;
    }
    return dangerReason;
  };
}
