import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { EthosError } from '@ethosagent/types';
export class ApprovalsService {
    opts;
    pending = new Map();
    emitter = new EventEmitter();
    constructor(opts) {
        this.opts = opts;
        // Many SSE subscribers per session — no warning at 10.
        this.emitter.setMaxListeners(0);
    }
    /**
     * Hook side. Returns a Promise that resolves once the user (or another
     * tab) calls `approve` or `deny`. Allowlist hits short-circuit to
     * `{ decision: 'allow' }` without any user interaction.
     */
    async requestApproval(req) {
        if (await this.opts.allowlist.matches(req.toolName, req.args)) {
            return { decision: 'allow' };
        }
        const approvalId = randomUUID();
        return new Promise((resolve) => {
            this.pending.set(approvalId, { resolve, request: req });
            const wireRequest = {
                approvalId,
                sessionId: req.sessionId,
                toolCallId: req.toolCallId,
                toolName: req.toolName,
                args: req.args,
                reason: req.reason ?? null,
            };
            this.emitter.emit('pending', req.sessionId, wireRequest);
        });
    }
    /**
     * Resolve a pending approval as allowed. When `scope` is `exact-args` or
     * `any-args` the decision is persisted to the allowlist so future identical
     * calls auto-allow. `once` is in-memory only.
     */
    async approve(approvalId, scope, decidedBy) {
        const p = this.take(approvalId);
        if (scope !== 'once') {
            await this.opts.allowlist.add({
                toolName: p.request.toolName,
                scope,
                args: scope === 'exact-args' ? p.request.args : null,
            });
        }
        p.resolve({ decision: 'allow' });
        this.emitter.emit('resolved', p.request.sessionId, approvalId, 'allow', decidedBy);
    }
    async deny(approvalId, reason, decidedBy) {
        const p = this.take(approvalId);
        p.resolve({ decision: 'deny', reason: reason ?? 'denied by user' });
        this.emitter.emit('resolved', p.request.sessionId, approvalId, 'deny', decidedBy);
    }
    /**
     * Drop every pending approval for a session — called when the session is
     * forgotten so the agent loop unblocks instead of waiting forever for a
     * decision that will never come.
     */
    cancelForSession(sessionId, reason = 'session ended') {
        for (const [approvalId, p] of this.pending.entries()) {
            if (p.request.sessionId !== sessionId)
                continue;
            this.pending.delete(approvalId);
            p.resolve({ decision: 'deny', reason });
        }
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
    take(approvalId) {
        const p = this.pending.get(approvalId);
        if (!p) {
            throw new EthosError({
                code: 'INVALID_INPUT',
                cause: `No pending approval for id ${approvalId}`,
                action: 'The approval was already resolved (likely by another tab) or the agent moved on. Reload to see the current state.',
            });
        }
        this.pending.delete(approvalId);
        return p;
    }
}
