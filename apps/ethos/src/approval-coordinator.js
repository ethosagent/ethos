import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** Decider id used for non-user resolutions (timeout, session cancel). It is
 *  the one value that bypasses the `requesterUserId` binding check. */
const SYSTEM_DECIDER = '__ethos_system__';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export class ApprovalCoordinator {
  pending = new Map();
  emitter = new EventEmitter();
  timeoutMs;
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Glue may attach several listeners (card poster + observability); the
    // default cap of 10 is plenty but we silence the warning to be safe.
    this.emitter.setMaxListeners(0);
  }
  /**
   * Hook side. Returns a Promise that resolves once `approve` / `deny` is
   * called for the emitted `approvalId`.
   */
  requestApproval(req) {
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const request = {
        approvalId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason,
        requesterUserId: req.requesterUserId,
      };
      let timer;
      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.settle(
            approvalId,
            { decision: 'deny', reason: 'approval timed out' },
            SYSTEM_DECIDER,
          );
        }, this.timeoutMs);
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
  async approve(approvalId, decidedBy) {
    this.settle(approvalId, { decision: 'allow' }, decidedBy);
  }
  /** Resolve a pending approval as denied. Idempotent (see `approve`). */
  async deny(approvalId, decidedBy) {
    this.settle(approvalId, { decision: 'deny', reason: 'denied by user' }, decidedBy);
  }
  /**
   * Drop every pending approval for a session — called when the session is
   * forgotten so the agent loop unblocks instead of waiting forever for a
   * decision that will never come.
   */
  cancelForSession(sessionId, reason = 'session ended') {
    for (const [approvalId, entry] of this.pending.entries()) {
      if (entry.request.sessionId !== sessionId) continue;
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
  settle(approvalId, decision, decidedBy) {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    const requester = entry.request.requesterUserId;
    if (requester !== undefined && decidedBy !== SYSTEM_DECIDER && decidedBy !== requester) {
      return;
    }
    this.pending.delete(approvalId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(decision);
    this.emitter.emit('resolved', approvalId, decision.decision, decidedBy);
  }
  /** Visible for tests + internal observability. */
  pendingCount() {
    return this.pending.size;
  }
  onPending(handler) {
    this.emitter.on('pending', handler);
    return () => {
      this.emitter.off('pending', handler);
    };
  }
  onResolved(handler) {
    this.emitter.on('resolved', handler);
    return () => {
      this.emitter.off('resolved', handler);
    };
  }
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
export function createSlackApprovalHook(opts) {
  return async (payload) => {
    const reason = opts.isDangerous(payload);
    if (reason === null) return null;
    // No Slack approval surface for this turn (a non-Slack channel sharing
    // the loop) — pass through untouched. Suspending or denying here would
    // be hidden cross-platform coupling.
    const target = opts.resolveApprovalTarget(payload.sessionId);
    if (target === undefined) return null;
    const decision = await opts.coordinator.requestApproval({
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
      reason,
      requesterUserId: target.requesterUserId,
    });
    if (decision.decision === 'allow') return null;
    return { error: decision.reason };
  };
}
