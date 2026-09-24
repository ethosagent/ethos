import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type ApprovalLease, EthosError, isLeaseActive } from '@ethosagent/types';
import type { ApprovalRequest, ApprovalScope } from '@ethosagent/web-contracts';
import type { AllowlistRepository } from '../repositories/allowlist.repository';
import type { LeaseRepository } from '../repositories/lease.repository';

// In-process state machine for tool approvals. Bridges the agent loop's
// synchronous `before_tool_call` hook (an awaited Promise) with the user's
// asynchronous decision arriving as a separate HTTP request hours later.
//
//   loop                       ApprovalsService                client tab
//   ----                       ----------------                ----------
//   hook fires ── requestApproval ─────► register pending,
//                                        emit('pending')   ──► SSE event
//                                                              user clicks
//   hook awaits ◄────────── promise ◄── approve()/deny() ◄── /rpc/tools/*
//
// The Promise stored in `pending` is the only thread of control that remembers
// "the agent is paused on this tool call." Resolving it lets the loop continue;
// rejecting (deny) translates into a `{ error }` returned from the hook,
// which the loop renders as a tool_result with is_error=true.

export interface ApprovalRequestInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Human-readable cause — e.g. "recursive force-delete of root directory". */
  reason?: string;
  /** Personality running the turn (`BeforeToolCallPayload.personalityId`).
   *  A lease binds to it; absent binds a lease to "no personality". An
   *  allowlist entry binds to it too, and a request without it never matches
   *  one (`AllowlistRepository.matches`). */
  personalityId?: string;
}

export type ApprovalDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  request: ApprovalRequestInput;
  /** Auto-deny timer — cleared the moment any decision lands. Absent when
   *  the timeout is disabled (`timeoutMs <= 0`). */
  timer?: NodeJS.Timeout;
}

interface ApprovalEventMap {
  pending: [sessionId: string, request: ApprovalRequest];
  resolved: [sessionId: string, approvalId: string, decision: 'allow' | 'deny', decidedBy: string];
}

/**
 * Minimal observability surface the approval audit trail needs. Declared
 * locally so this service stays dependency-light; wiring's
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

export interface ApprovalsServiceOptions {
  allowlist: AllowlistRepository;
  /**
   * Time-limited grants (`lease-1h`). Consulted on every gated call BEFORE the
   * allowlist. Absent (tests of the plain allowlist flow) means no lease is
   * ever found and `approve(..., 'lease-1h')` is refused.
   */
  leases?: LeaseRepository;
  /**
   * Always-ask tools (D3-12): never allowlistable, and flagged `alwaysAsk` on
   * the wire so the modal offers "Allow for 1 hour" instead. The composition
   * root (`createWebApi`) passes `APPROVAL_SURFACE_ALWAYS_ASK` from
   * `@ethosagent/wiring` — the same list the danger predicate prompts for;
   * injected rather than imported so this service does not load the whole
   * wiring graph. Absent = none.
   */
  alwaysAsk?: ReadonlyArray<string>;
  /**
   * Auto-deny a pending approval after this many ms. The backstop for a
   * closed tab, a dropped SSE stream, or any integration failure that would
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

/** Decider id used for non-user resolutions (timeout, forced shutdown).
 *  Duplicated — deliberately, per this file's sibling relationship with
 *  `apps/ethos/src/approval-coordinator.ts`, which declares the identical
 *  constant. Keep the two literals in sync. */
const SYSTEM_DECIDER = '__ethos_system__';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Longest delay `setTimeout` can represent (32-bit signed ms, ~24.8 days).
 *  Duplicated — deliberately, per this file's sibling relationship with
 *  `apps/ethos/src/approval-coordinator.ts`, which declares the identical
 *  constant. Keep the two literals in sync. */
const MAX_TIMER_MS = 2_147_483_647;

/** The one lease duration this phase ships (D3-8). The store takes `ttlMs`,
 *  so a later surface can pass another value without a schema change. */
export const LEASE_1H_MS = 3_600_000;

const AUDIT_CODES = {
  approved: 'approval.allow',
  denied: 'approval.deny',
  auto: 'approval.auto_allow',
} as const;

export class ApprovalsService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly emitter = new EventEmitter<ApprovalEventMap>();
  private readonly timeoutMs: number;

  constructor(private readonly opts: ApprovalsServiceOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Many SSE subscribers per session — no warning at 10.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Hook side. Returns a Promise that resolves once the user (or another
   * tab) calls `approve` or `deny`. Allowlist hits short-circuit to
   * `{ decision: 'allow' }` without any user interaction.
   *
   * `timeoutMs` overrides the store's configured auto-deny window for this
   * one request — for callers whose wait is legitimately longer than the
   * attended-tab default (an unattended background run). Omit to use the
   * store default; `0` disables the timer for this request.
   */
  async requestApproval(req: ApprovalRequestInput, timeoutMs?: number): Promise<ApprovalDecision> {
    // A lease is checked on EVERY gated call, against the clock, so expiry and
    // revocation take effect on the next call with no timer (D3-10).
    const lease = await this.opts.leases?.findActive(
      req.toolName,
      req.sessionId,
      req.personalityId ?? null,
      Date.now(),
    );
    if (lease) {
      this.audit(req, 'auto', 'lease', `matched lease ${lease.id}, expires ${lease.expiresAt}`, {
        leaseId: lease.id,
      });
      return { decision: 'allow' };
    }
    if (await this.opts.allowlist.matches(req.personalityId, req.toolName, req.args)) {
      // No human in the loop — an allowlist entry decided. Exactly the kind
      // of silent auto-approval the audit trail exists to make visible.
      this.audit(req, 'auto', 'allowlist', 'matched a stored allowlist entry');
      return { decision: 'allow' };
    }
    const approvalId = randomUUID();
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    return new Promise<ApprovalDecision>((resolve) => {
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
            // Reuse `deny()` so the timeout's audit row is structurally
            // identical to a human deny. `take()` throws on an already-resolved
            // id, so a timer racing a decision must swallow — never an
            // unhandled rejection.
            void this.deny(approvalId, 'approval timed out', SYSTEM_DECIDER).catch(() => {});
          },
          Math.min(effectiveTimeout, MAX_TIMER_MS),
        );
        // Don't keep the process alive solely for a pending approval.
        timer.unref?.();
      }
      this.pending.set(approvalId, { resolve, request: req, timer });
      const wireRequest: ApprovalRequest = {
        approvalId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason ?? null,
        alwaysAsk: this.isAlwaysAsk(req.toolName),
      };
      this.emitter.emit('pending', req.sessionId, wireRequest);
    });
  }

  /**
   * Resolve a pending approval as allowed. When `scope` is `exact-args` or
   * `any-args` the decision is persisted to the allowlist so future identical
   * calls auto-allow. `lease-1h` grants a one-hour lease bound to the call's
   * tool, session and personality. `once` is in-memory only.
   *
   * An always-ask tool cannot be allowlisted (D3-12): `exact-args`/`any-args`
   * on one is refused BEFORE the pending approval is consumed, so the modal
   * stays open for a valid answer.
   */
  async approve(approvalId: string, scope: ApprovalScope, decidedBy: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (pending && (scope === 'exact-args' || scope === 'any-args')) {
      if (this.isAlwaysAsk(pending.request.toolName)) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `${pending.request.toolName} is an always-ask tool and cannot be allowlisted (${scope}).`,
          action: 'Allow it once, or for 1 hour.',
        });
      }
    }
    if (pending && scope === 'lease-1h' && !this.opts.leases) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'No lease store is wired, so a 1-hour grant cannot be recorded.',
        action: 'Allow it once instead.',
      });
    }
    const p = this.take(approvalId);
    let lease: ApprovalLease | undefined;
    if (scope === 'lease-1h' && this.opts.leases) {
      lease = await this.opts.leases.grant(
        {
          toolName: p.request.toolName,
          sessionId: p.request.sessionId,
          personalityId: p.request.personalityId ?? null,
          grantedBy: decidedBy,
        },
        LEASE_1H_MS,
      );
    } else if (scope === 'exact-args' || scope === 'any-args') {
      await this.opts.allowlist.add({
        // Binds the grant to the personality whose call it approved; a
        // request with no personality stores an entry that matches nothing.
        ...(p.request.personalityId !== undefined
          ? { personalityId: p.request.personalityId }
          : {}),
        toolName: p.request.toolName,
        scope,
        args: scope === 'exact-args' ? p.request.args : null,
      });
    }
    this.audit(p.request, 'approved', decidedBy, p.request.reason ?? 'approved', {
      approvalId,
      scope,
      ...(lease ? { leaseId: lease.id, expiresAt: lease.expiresAt } : {}),
    });
    p.resolve({ decision: 'allow' });
    this.emitter.emit('resolved', p.request.sessionId, approvalId, 'allow', decidedBy);
  }

  async deny(approvalId: string, reason: string | undefined, decidedBy: string): Promise<void> {
    const p = this.take(approvalId);
    const denyReason = reason ?? 'denied by user';
    this.audit(p.request, 'denied', decidedBy, denyReason, { approvalId });
    p.resolve({ decision: 'deny', reason: denyReason });
    this.emitter.emit('resolved', p.request.sessionId, approvalId, 'deny', decidedBy);
  }

  /**
   * Drop every pending approval for a session — called when the session is
   * forgotten so the agent loop unblocks instead of waiting forever for a
   * decision that will never come.
   */
  cancelForSession(sessionId: string, reason = 'session ended'): void {
    for (const [approvalId, p] of this.pending.entries()) {
      if (p.request.sessionId !== sessionId) continue;
      this.pending.delete(approvalId);
      if (p.timer) clearTimeout(p.timer);
      this.audit(p.request, 'denied', 'system', reason, { approvalId });
      p.resolve({ decision: 'deny', reason });
    }
  }

  /**
   * Force-settle EVERY pending approval as a deny — the shutdown backstop.
   * Called from the CLI's `serve` shutdown `cleanup()` closure (this service
   * registers no `process.on` handler of its own; signal ownership lives at
   * the command layer). Without it a graceful restart abandons every
   * suspended hook with no audit row, because the auto-deny timers are
   * `unref`'d and never fire once the process is on its way out.
   *
   * Modelled on `cancelForSession` rather than looping over `deny()`: it
   * stays synchronous and is immune to `take()`'s throw-on-unknown-id. The
   * `resolved` emit is copied from `deny()` all the same — without it an open
   * dashboard tab keeps rendering an actionable modal for an approval that
   * was already denied and audited.
   */
  forceSettleAll(reason = 'server shutting down'): void {
    for (const [approvalId, p] of this.pending.entries()) {
      this.pending.delete(approvalId);
      if (p.timer) clearTimeout(p.timer);
      this.audit(p.request, 'denied', SYSTEM_DECIDER, reason, { approvalId });
      p.resolve({ decision: 'deny', reason });
      this.emitter.emit('resolved', p.request.sessionId, approvalId, 'deny', SYSTEM_DECIDER);
    }
  }

  /**
   * Write one decision to the safety audit trail (`ethos audit decisions`).
   * Called from every path that settles an approval — user decision,
   * allowlist auto-allow, session cancel — so the trail has no holes.
   *
   * Fail-open by construction: a throwing sink must never break a tool call
   * the agent is already suspended on.
   */
  private audit(
    request: ApprovalRequestInput,
    decision: 'approved' | 'denied' | 'auto',
    decidedBy: string,
    cause: string,
    extraDetails: Record<string, unknown> = {},
  ): void {
    const obs = this.opts.observability;
    if (!obs) return;
    try {
      obs.recordSafetyApproval({
        decision,
        severity: decision === 'denied' ? 'warn' : 'info',
        code: AUDIT_CODES[decision],
        cause: `${request.toolName}: ${cause}`,
        details: {
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          decidedBy,
          ...(request.reason ? { reason: request.reason } : {}),
          ...extraDetails,
        },
      });
    } catch {
      // Audit is fail-open — a broken sink never breaks an approval.
    }
  }

  /** True for a tool no allowlist entry may ever auto-approve (D3-12): the
   *  always-ask list's own definition is "must never run without a prompt"
   *  (`APPROVAL_SURFACE_ALWAYS_ASK` in `packages/wiring/src/danger-predicate.ts`). */
  private isAlwaysAsk(toolName: string): boolean {
    return (this.opts.alwaysAsk ?? []).includes(toolName);
  }

  /** Leases that are active right now — the Settings → Approvals list. */
  async listActiveLeases(): Promise<ApprovalLease[]> {
    const nowMs = Date.now();
    return ((await this.opts.leases?.list()) ?? []).filter((l) => isLeaseActive(l, nowMs));
  }

  /**
   * Revoke a lease. Takes effect on the next gated call, which re-checks the
   * store (D3-10) — nothing else needs to be told.
   */
  async revokeLease(leaseId: string): Promise<void> {
    const lease = await this.opts.leases?.revoke(leaseId);
    if (!lease) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: `No approval lease with id ${leaseId}`,
        action: 'Reload the Approvals list to see the current leases.',
      });
    }
  }

  /** Visible for tests + internal observability. */
  pendingCount(): number {
    return this.pending.size;
  }

  onPending(handler: (sessionId: string, request: ApprovalRequest) => void): () => void {
    this.emitter.on('pending', handler);
    return () => {
      this.emitter.off('pending', handler);
    };
  }

  onResolved(
    handler: (
      sessionId: string,
      approvalId: string,
      decision: 'allow' | 'deny',
      decidedBy: string,
    ) => void,
  ): () => void {
    this.emitter.on('resolved', handler);
    return () => {
      this.emitter.off('resolved', handler);
    };
  }

  private take(approvalId: string): PendingApproval {
    const p = this.pending.get(approvalId);
    if (!p) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `No pending approval for id ${approvalId}`,
        action:
          'The approval was already resolved (likely by another tab) or the agent moved on. Reload to see the current state.',
      });
    }
    this.pending.delete(approvalId);
    // The single removal point, so every settle path (approve, deny, and the
    // timeout's own deny) disarms the auto-deny timer for free.
    if (p.timer) clearTimeout(p.timer);
    return p;
  }
}
