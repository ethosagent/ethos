import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

// In-process state machine for tool approvals in the gateway profile —
// the channel-adapter analogue of web-api's `ApprovalsService`. It bridges
// the agent loop's synchronous `before_tool_call` hook (an awaited Promise)
// with the user's asynchronous decision arriving as a Slack button click.
//
//   loop                    ApprovalCoordinator            Slack
//   ----                    -------------------            -----
//   hook fires ─ requestApproval ──► register pending,
//                                    emit('pending')   ──► post approval card
//                                                          user clicks button
//   hook awaits ◄──────── promise ◄── approve()/deny() ◄── action handler
//
// The Promise stored in `pending` is the only thread of control that
// remembers "the agent is paused on this tool call." Resolving it lets the
// loop continue; a deny translates into a `{ error }` returned from the hook,
// which the loop renders as a tool_result with is_error=true.
//
// This module is platform-agnostic by construction — it never imports the
// Slack adapter. The gateway command wires the glue: `onPending` → post a
// card, the adapter's button-click event → `approve()` / `deny()`.

export type ApprovalDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** A pending approval surfaced to the `onPending` subscriber. */
export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Human-readable cause from the danger predicate, or null. */
  reason: string | null;
  /**
   * Platform user id of the one user allowed to decide. When set, only that
   * user (or a `'system'` resolution — timeout / session cancel) may resolve
   * the approval (`settle` drops every other click). The name is historical:
   * the caller picks the decider, and on the gateway that is the requester in
   * a DM but the platform owner in a group (`resolveApprovalTarget` inside
   * `wireApprovalFlow`, apps/ethos/src/commands/gateway.ts). Unset means no
   * binding — any decider is accepted.
   */
  requesterUserId?: string;
}

export interface RequestApprovalInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  reason: string | null;
  /** See `PendingApproval.requesterUserId`. */
  requesterUserId?: string;
  /**
   * Override the coordinator's configured auto-deny window for this one
   * request — for callers whose wait is legitimately longer than the
   * attended-card default (an unattended background run). Omit to use the
   * coordinator default; `0` disables the timer for this request.
   */
  timeoutMs?: number;
}

/** Decider id used for non-user resolutions (timeout, session cancel). It is
 *  the one value that bypasses the `requesterUserId` binding check. */
const SYSTEM_DECIDER = '__ethos_system__';

interface PendingEntry {
  resolve: (d: ApprovalDecision) => void;
  request: PendingApproval;
  /** Auto-deny timer — cleared the moment any decision lands. Absent when
   *  the timeout is disabled (`timeoutMs <= 0`). */
  timer?: NodeJS.Timeout;
}

interface CoordinatorEventMap {
  pending: [PendingApproval];
  resolved: [approvalId: string, decision: 'allow' | 'deny', decidedBy: string];
}

/**
 * Minimal observability surface the approval audit trail needs. Declared
 * locally so this module keeps its zero-extension-import shape; wiring's
 * `EthosObservability` satisfies it structurally.
 */
export interface ApprovalObservability {
  recordSafetyApproval(opts: {
    decision: 'approved' | 'denied' | 'auto';
    severity?: 'info' | 'warn';
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

export interface ApprovalCoordinatorOptions {
  /**
   * Auto-deny a pending approval after this many ms. The backstop for a lost
   * button click, a deleted card, or any integration failure that would
   * otherwise leave the agent loop's hook suspended forever. Defaults to 10
   * minutes; pass `0` to disable (tests, trusted-local automation).
   */
  timeoutMs?: number;
  /**
   * Sink for the safety audit trail (`ethos audit decisions`). Optional —
   * absent means no audit rows, never a broken approval.
   */
  observability?: ApprovalObservability;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Longest delay `setTimeout` can represent (32-bit signed ms, ~24.8 days).
 *  Duplicated — deliberately, per this file's sibling relationship with
 *  `apps/web-api/src/services/approvals.service.ts`, which declares the
 *  identical constant. Keep the two literals in sync. */
const MAX_TIMER_MS = 2_147_483_647;

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly emitter = new EventEmitter<CoordinatorEventMap>();
  private readonly timeoutMs: number;
  private readonly observability: ApprovalObservability | undefined;

  constructor(opts: ApprovalCoordinatorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.observability = opts.observability;
    // Glue may attach several listeners (card poster + observability); the
    // default cap of 10 is plenty but we silence the warning to be safe.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Hook side. Returns a Promise that resolves once `approve` / `deny` is
   * called for the emitted `approvalId`.
   */
  requestApproval(req: RequestApprovalInput): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      const request: PendingApproval = {
        approvalId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason,
        requesterUserId: req.requesterUserId,
      };
      const effectiveTimeout = req.timeoutMs ?? this.timeoutMs;
      let timer: NodeJS.Timeout | undefined;
      if (effectiveTimeout > 0) {
        // Clamped: a delay above the Node timer max overflows the 32-bit
        // signed int and fires in ~1ms, so an operator asking for a LONGER
        // window (say a 30-day SLA) would silently auto-deny every dangerous
        // call instantly. Clamping to the longest delay the platform can
        // actually represent keeps the gate fail-closed and as close to the
        // requested SLA as possible. It must never become "no timer" — that
        // would flip a safety gate fail-open.
        timer = setTimeout(
          () => {
            this.settle(
              approvalId,
              { decision: 'deny', reason: 'approval timed out' },
              SYSTEM_DECIDER,
            );
          },
          Math.min(effectiveTimeout, MAX_TIMER_MS),
        );
        // Don't keep the process alive solely for a pending approval.
        timer.unref?.();
      }
      this.pending.set(approvalId, { resolve, request, timer });
      this.emitter.emit('pending', request);
    });
  }

  /** Resolve a pending approval as allowed. Idempotent — a decision for an
   *  already-resolved (or unknown) approvalId is a silent no-op, so a stale
   *  button click from a second surface never throws or flips the result. */
  async approve(approvalId: string, decidedBy: string): Promise<void> {
    this.settle(approvalId, { decision: 'allow' }, decidedBy);
  }

  /** Resolve a pending approval as denied. Idempotent (see `approve`). */
  async deny(approvalId: string, decidedBy: string): Promise<void> {
    this.settle(approvalId, { decision: 'deny', reason: 'denied by user' }, decidedBy);
  }

  /**
   * Drop every pending approval for a session — called when the session is
   * forgotten so the agent loop unblocks instead of waiting forever for a
   * decision that will never come.
   */
  cancelForSession(sessionId: string, reason = 'session ended'): void {
    for (const [approvalId, entry] of this.pending.entries()) {
      if (entry.request.sessionId !== sessionId) continue;
      this.settle(approvalId, { decision: 'deny', reason }, SYSTEM_DECIDER);
    }
  }

  /**
   * Force-settle EVERY pending approval as a deny — `cancelForSession`
   * without the session filter. Called from the gateway command's shutdown
   * closure: the auto-deny timers are `unref`'d, so a graceful restart would
   * otherwise abandon every suspended hook with no settle, no audit row and
   * no card update.
   */
  forceSettleAll(reason = 'gateway shutting down'): void {
    // Snapshot the keys — `settle` mutates the map as it goes.
    for (const approvalId of [...this.pending.keys()]) {
      this.settle(approvalId, { decision: 'deny', reason }, SYSTEM_DECIDER);
    }
  }

  /**
   * The single resolution path — every decision (button click, timeout,
   * session cancel) funnels through here. Idempotent: an unknown or
   * already-resolved approvalId is a no-op, which is what makes a stale
   * click or a timeout-after-decision harmless. Clears the auto-deny timer
   * so a resolved approval never double-fires.
   *
   * Enforces the requester binding: when the pending approval carries a
   * `requesterUserId`, only that user — or a `SYSTEM_DECIDER` resolution —
   * may settle it. A bystander's click is dropped, leaving the approval
   * pending for the rightful decider (or the timeout backstop).
   */
  private settle(approvalId: string, decision: ApprovalDecision, decidedBy: string): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    const requester = entry.request.requesterUserId;
    if (requester !== undefined && decidedBy !== SYSTEM_DECIDER && decidedBy !== requester) {
      return;
    }
    this.pending.delete(approvalId);
    if (entry.timer) clearTimeout(entry.timer);
    this.audit(entry.request, decision, decidedBy);
    entry.resolve(decision);
    this.emitter.emit('resolved', approvalId, decision.decision, decidedBy);
  }

  /**
   * Write one decision to the safety audit trail. Sits inside `settle` so
   * EVERY resolution is recorded — button click, timeout auto-deny, session
   * cancel — not just the ones a surface remembered to subscribe to.
   *
   * Fail-open by construction: a throwing (or unavailable) sink must never
   * block a tool call the agent is already suspended on.
   */
  private audit(request: PendingApproval, decision: ApprovalDecision, decidedBy: string): void {
    if (!this.observability) return;
    const denied = decision.decision === 'deny';
    const cause = denied ? decision.reason : (request.reason ?? 'approved');
    try {
      this.observability.recordSafetyApproval({
        decision: denied ? 'denied' : 'approved',
        severity: denied ? 'warn' : 'info',
        code: denied ? 'approval.deny' : 'approval.allow',
        cause: `${request.toolName}: ${cause}`,
        details: {
          approvalId: request.approvalId,
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          decidedBy,
          ...(request.reason ? { reason: request.reason } : {}),
        },
      });
    } catch {
      // Audit is fail-open — a broken sink never breaks an approval.
    }
  }

  /** Visible for tests + internal observability. */
  pendingCount(): number {
    return this.pending.size;
  }

  onPending(handler: (request: PendingApproval) => void): () => void {
    this.emitter.on('pending', handler);
    return () => {
      this.emitter.off('pending', handler);
    };
  }

  onResolved(
    handler: (approvalId: string, decision: 'allow' | 'deny', decidedBy: string) => void,
  ): () => void {
    this.emitter.on('resolved', handler);
    return () => {
      this.emitter.off('resolved', handler);
    };
  }
}

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => Promise<DangerReason>;

/** Who decides a turn's approval. Built by `resolveApprovalTarget` inside
 *  `wireApprovalFlow` (apps/ethos/src/commands/gateway.ts). */
export interface ApprovalTarget {
  /** Platform user id of the one user allowed to decide — only they (or a
   *  system resolution) may resolve the approval (`ApprovalCoordinator.settle`).
   *  `resolveApprovalTarget` sets it to the requester in a DM, to the platform
   *  owner (`channel_filter.<platform>.ownerUserId`) in a group, and to the
   *  requester in a group whose platform has no owner configured. Pinned by
   *  apps/ethos/src/commands/__tests__/approval-target.test.ts. */
  requesterUserId?: string;
}

export interface CreateSlackApprovalHookOptions {
  coordinator: ApprovalCoordinator;
  isDangerous: DangerPredicate;
  /**
   * Resolves the `sessionId` to its approval target, or `undefined` when the
   * turn's route adapter cannot post an approval card.
   *
   * The same `AgentLoop` can be shared by a card-capable adapter AND one that
   * is not (an Email or WhatsApp message that fell back to a Slack-bound
   * bot's loop). Nobody can be asked on such a turn, so it is handed to
   * `withoutSurface` instead — exactly the gate a bot with no card-capable
   * adapter at all gets, so adding Slack to a bot does not change tool
   * behaviour on its other channels.
   *
   * `before_tool_call` carries only `sessionId`; the gateway is the
   * component that knows both the originating platform and user.
   */
  resolveApprovalTarget: (sessionId: string) => ApprovalTarget | undefined;
  /**
   * The `before_tool_call` handler for a turn with no approval surface
   * (`resolveApprovalTarget` returned `undefined`). `wireApprovalFlow` passes
   * the unattended gate (`createUnattendedGateHandler`,
   * apps/ethos/src/unattended-approval-gate.ts), which refuses a flagged call
   * unless the D12 opt-in pre-authorizes it. Required so no caller can
   * silently fall back to letting such a call through. Pinned by
   * apps/ethos/src/commands/__tests__/approval-flow-unattended.test.ts.
   */
  withoutSurface: (payload: BeforeToolCallPayload) => Promise<{ error?: string }>;
}

/**
 * `before_tool_call` hook handler for the gateway/Slack profile. Mirrors
 * web-api's `createWebApprovalHook`: a non-dangerous call passes straight
 * through; a dangerous one is registered with the coordinator and the hook
 * suspends on the returned Promise until the user clicks Allow / Deny.
 *
 * The danger predicate is injected so this file stays free of any extension
 * imports — see `@ethosagent/wiring`'s `createDangerPredicate`.
 */
export function createSlackApprovalHook(opts: CreateSlackApprovalHookOptions) {
  return async (payload: BeforeToolCallPayload): Promise<Partial<BeforeToolCallResult> | null> => {
    // No approval surface for this turn (a non-card channel sharing the loop)
    // — nobody can be asked, so the unattended gate decides, with its own
    // predicate (it carries the D12 opt-in; `isDangerous` does not). Resolved
    // first so a flagged call is judged once, not twice.
    const target = opts.resolveApprovalTarget(payload.sessionId);
    if (target === undefined) return opts.withoutSurface(payload);

    const reason = await opts.isDangerous(payload);
    if (reason === null) return null;

    const decision = await opts.coordinator.requestApproval({
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
      reason,
      requesterUserId: target.requesterUserId,
    });

    if (decision.decision === 'allow') return null;
    // Relay the SPECIFIC danger reason alongside the decision. `decision.reason`
    // alone is generic ('denied by user', 'approval timed out'), which tells the
    // agent nothing it can act on; the computed reason names what was dangerous.
    return { error: `${decision.reason} — ${reason}` };
  };
}
