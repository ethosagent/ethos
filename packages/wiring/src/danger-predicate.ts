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
 *   1. Always-ask list   → return reason (drives modal in every mode).
 *   2. Hardline command  → return reason (Ch.4a — non-overridable; the
 *                          terminalGuardHook hard-blocks separately so
 *                          this is belt + suspenders).
 *   3. approvalMode      →
 *        manual (default) → return any other dangerous reason as before.
 *        off              → return null for every NON-hardline danger
 *                           (auto-approve — the hardline guard hook
 *                           still blocks, even in `off`).
 *        smart            → consult `smartApprove` callback. true =
 *                           auto-approve, false = surface the reason.
 *                           Without the callback wired, smart degrades
 *                           to manual.
 */
export function createDangerPredicate(opts: CreateDangerPredicateOptions = {}): DangerPredicate {
  const alwaysAsk = new Set(opts.alwaysAsk ?? []);
  return (payload) => {
    if (alwaysAsk.has(payload.toolName)) {
      return `${payload.toolName} requires explicit approval`;
    }

    let dangerReason: string | null = null;
    let isHardline = false;
    if (payload.toolName === 'terminal') {
      const args = payload.args as { command?: string } | null | undefined;
      if (args?.command) {
        const result = checkCommand(args.command);
        if (result.dangerous) {
          dangerReason = result.reason;
          isHardline = true; // every checkCommand hit is hardline today
        }
      }
    }

    if (!dangerReason) return null;

    // Hardline always surfaces — even in `off` mode the guard hook will
    // hard-block, but the predicate keeps returning the reason so any
    // intermediate UI still shows it.
    if (isHardline) return dangerReason;

    const mode = opts.getPersonality?.(payload)?.safety?.approvalMode ?? 'manual';
    if (mode === 'off') return null;
    if (mode === 'smart' && opts.smartApprove) {
      const approved = opts.smartApprove(payload, dangerReason);
      return approved ? null : dangerReason;
    }
    return dangerReason;
  };
}
