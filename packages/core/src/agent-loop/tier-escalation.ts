// `think_deeper` escalation guards (plan think-deeper-tier-switch, P2/P3).
//
// The flag itself (`tierEscalationRef`) has two owners and no third: the SETTER
// is stages/tool-processing.ts, the CONSUMER is stages/stream-step.ts. This file
// holds the pure helpers they share: the reason cleaner and the cap check.

import type { ModelTierName } from '@ethosagent/types';
import { stripAnsiEscapes } from '../sanitize-output';

/**
 * The run-local escalation flag (`AgentLoop.run` makes one per run). SET by
 * stages/tool-processing.ts on a successful `think_deeper`, CONSUMED and
 * cleared by stages/stream-step.ts; `perTurn` is the count of successful
 * escalations so far this run, bumped by the setter alone. Internal, not a
 * contract.
 */
export interface TierEscalationRef {
  value?: ModelTierName;
  /** The cleaned `reason` of the escalation `value` stands for. */
  reason?: string;
  perTurn: number;
}

/**
 * Escalations one turn may make. Hard-coded on purpose, like
 * `MAX_CONSECUTIVE_DENIALS` (./budgets.ts): a model that has escalated twice
 * in a turn gains nothing from a third, and a config knob is speculation until
 * someone asks for one. Enforced by `checkEscalationCap`, called from the
 * prep loop in stages/tool-processing.ts; pinned by `escalation caps` in
 * `__tests__/model-tier.test.ts`.
 */
export const MAX_ESCALATIONS_PER_TURN = 2;

/** Escalations one session may make (in memory, like `sessionCosts`). */
export const MAX_ESCALATIONS_PER_SESSION = 10;

/** Longest reason a surface ever sees, ellipsis included. */
export const ESCALATION_REASON_MAX_CHARS = 160;

/**
 * The model's free-text `reason` arg, made safe to render: ANSI and control
 * characters dropped, whitespace collapsed, cut to
 * {@link ESCALATION_REASON_MAX_CHARS}. Non-string input is `''`. Pinned by
 * `__tests__/tier-escalation.test.ts`.
 */
export function escalationReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of stripAnsiEscapes(raw)) {
    const code = ch.codePointAt(0) ?? 0;
    const isWhitespace = ch === '\n' || ch === '\r' || ch === '\t';
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isWhitespace) out += ' ';
    else if (!isControl) out += ch;
  }
  const clean = out.replace(/\s+/g, ' ').trim();
  if (clean.length <= ESCALATION_REASON_MAX_CHARS) return clean;
  return `${clean.slice(0, ESCALATION_REASON_MAX_CHARS - 1)}…`;
}

export type EscalationCap = { ok: true } | { ok: false; message: string };

/** Whether one more escalation is allowed, given what this turn and session already made. */
export function checkEscalationCap(counts: { perTurn: number; perSession: number }): EscalationCap {
  if (counts.perTurn >= MAX_ESCALATIONS_PER_TURN) {
    return {
      ok: false,
      message: `Escalation limit reached for this turn (${MAX_ESCALATIONS_PER_TURN}). Continue on the current model.`,
    };
  }
  if (counts.perSession >= MAX_ESCALATIONS_PER_SESSION) {
    return {
      ok: false,
      message: `Escalation limit reached for this session (${MAX_ESCALATIONS_PER_SESSION}). Continue on the current model.`,
    };
  }
  return { ok: true };
}

/**
 * The prep-loop guard in stages/tool-processing.ts: the rejection message when
 * `toolName` is a `think_deeper` over its cap, else `undefined`.
 */
export function escalationCapMessage(
  toolName: string,
  ref: TierEscalationRef,
  sessionEscalations: ReadonlyMap<string, number>,
  sessionKey: string,
): string | undefined {
  if (toolName !== 'think_deeper') return undefined;
  const cap = checkEscalationCap({
    perTurn: ref.perTurn,
    perSession: sessionEscalations.get(sessionKey) ?? 0,
  });
  return cap.ok ? undefined : cap.message;
}

/**
 * The SETTER half of the flag, called once per batch by stages/tool-processing.ts
 * after a `think_deeper` succeeded. The reason comes from the call's effective
 * args, never from the tool's result string, and is cleaned here so no surface
 * sees raw model text. Counts one escalation per batch, however many
 * `think_deeper` calls it held, and only on success: a rejected call never
 * reaches here.
 */
export function recordEscalation(
  ref: TierEscalationRef,
  sessionEscalations: Map<string, number>,
  sessionKey: string,
  args: unknown,
): void {
  const raw =
    typeof args === 'object' && args !== null && 'reason' in args ? args.reason : undefined;
  ref.value = 'deep';
  ref.reason = escalationReason(raw);
  ref.perTurn += 1;
  sessionEscalations.set(sessionKey, (sessionEscalations.get(sessionKey) ?? 0) + 1);
}
