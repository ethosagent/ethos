// LoginSlots — the pending-flow map shared by McpDeviceLogin and McpPasteLogin
// (device-login.ts). One flow per (personality, server) grant slot, process-wide cap.
// No secret reaches the Logger or `recordEvent` (pinned by __tests__/device-login.test.ts
// "no secret reaches the logger").

import { randomBytes } from 'node:crypto';
import { noopLogger } from '@ethosagent/logger';
import type { Logger } from '@ethosagent/types';

export type LoginSurface = 'cli' | 'web' | 'gateway';
export type LoginStatus = 'pending' | 'connected' | 'denied' | 'expired' | 'cancelled' | 'error';
export type LoginSettledStatus = Exclude<LoginStatus, 'pending'>;

export interface LoginStatusResult {
  status: LoginStatus;
  serverName?: string;
  reason?: string;
}

export interface LoginSettlement {
  status: LoginSettledStatus;
  reason?: string;
}

/** One audit record per attempt phase (plan §9.3). Carries no secret. */
export interface LoginAuditEvent {
  server: string;
  personalityId?: string;
  flow: 'device' | 'paste';
  surface: LoginSurface;
  authHost?: string;
  outcome: 'started' | LoginSettledStatus | 'refused';
  code?: string;
  polls?: number;
  durationMs?: number;
}

export interface LoginSlotsOptions {
  logger?: Logger;
  recordEvent?: (event: LoginAuditEvent) => void;
  now?: () => number;
  /** Process-wide cap on concurrent pending flows. Default 10. */
  maxPending?: number;
  /** How long a terminal entry stays readable by `status`. Default 60 s. */
  terminalRetentionMs?: number;
}

const DEFAULT_MAX_PENDING = 10;
const DEFAULT_TERMINAL_RETENTION_MS = 60_000;

export interface Slot {
  flowId: string;
  key: string;
  kind: 'device' | 'paste';
  serverName: string;
  personalityId?: string;
  surface: LoginSurface;
  authHost?: string;
  status: LoginStatus;
  reason?: string;
  startedAt: number;
  settledAt?: number;
  /** Paste flows only: `sweep` expires the slot at this time. Device flows expire through the poller. */
  expiresAt?: number;
  /** Self-driving expiry for paste flows; cleared by `settle` and `refuse`. Enforced by the paste-TTL test in device-login.test.ts. */
  expiryTimer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  polls: number;
  listeners: Set<(s: LoginSettlement) => void>;
}

export type ReserveResult =
  | { ok: true; slot: Slot }
  | { ok: false; code: 'already_pending' | 'too_many_pending'; detail?: string };

/** The pending map, cap and key shared by McpDeviceLogin and McpPasteLogin. Pass one instance to both. */
export class LoginSlots {
  readonly logger: Logger;
  readonly now: () => number;
  private readonly recordEvent?: (event: LoginAuditEvent) => void;
  private readonly maxPending: number;
  private readonly retentionMs: number;
  private readonly flows = new Map<string, Slot>();

  constructor(opts: LoginSlotsOptions = {}) {
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.recordEvent = opts.recordEvent;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.retentionMs = opts.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  }

  static keyFor(personalityId: string | undefined, serverName: string): string {
    return `${personalityId ?? ''}::${serverName}`;
  }

  /** Drop expired terminal entries and expire overdue paste flows. */
  sweep(): void {
    const now = this.now();
    for (const slot of [...this.flows.values()]) {
      if (slot.status === 'pending') {
        if (slot.expiresAt !== undefined && now >= slot.expiresAt) this.settle(slot, 'expired');
      } else if (slot.settledAt !== undefined && now - slot.settledAt > this.retentionMs) {
        this.flows.delete(slot.flowId);
      }
    }
  }

  reserve(input: {
    serverName: string;
    personalityId?: string;
    surface: LoginSurface;
    kind: 'device' | 'paste';
    expiresAt?: number;
  }): ReserveResult {
    this.sweep();
    const key = LoginSlots.keyFor(input.personalityId, input.serverName);
    let pending = 0;
    for (const slot of this.flows.values()) {
      if (slot.status !== 'pending') continue;
      pending++;
      if (slot.key === key) {
        return {
          ok: false,
          code: 'already_pending',
          detail: `A sign-in for ${input.serverName} is already waiting.`,
        };
      }
    }
    if (pending >= this.maxPending) {
      return { ok: false, code: 'too_many_pending', detail: 'Too many sign-ins are in progress.' };
    }
    const slot: Slot = {
      flowId: randomBytes(16).toString('base64url'),
      key,
      kind: input.kind,
      serverName: input.serverName,
      ...(input.personalityId !== undefined ? { personalityId: input.personalityId } : {}),
      surface: input.surface,
      status: 'pending',
      startedAt: this.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      abort: new AbortController(),
      polls: 0,
      listeners: new Set(),
    };
    if (slot.expiresAt !== undefined) {
      const timer = setTimeout(
        () => this.settle(slot, 'expired'),
        Math.max(0, slot.expiresAt - this.now()),
      );
      timer.unref?.();
      slot.expiryTimer = timer;
    }
    this.flows.set(slot.flowId, slot);
    return { ok: true, slot };
  }

  /** Drop a reserved slot that never started (a refusal), and audit the refusal. */
  refuse(slot: Slot, code: string): void {
    clearTimeout(slot.expiryTimer);
    this.flows.delete(slot.flowId);
    this.emit(slot, 'refused', code);
  }

  /** Audit the start of a flow that is now running. */
  started(slot: Slot): void {
    this.emit(slot, 'started');
  }

  settle(slot: Slot, status: LoginSettledStatus, reason?: string): void {
    if (slot.status !== 'pending') return;
    clearTimeout(slot.expiryTimer);
    slot.status = status;
    if (reason !== undefined) slot.reason = reason;
    slot.settledAt = this.now();
    slot.abort.abort();
    this.emit(slot, status, status === 'error' ? reason : undefined);
    for (const cb of [...slot.listeners])
      this.notify(cb, { status, ...(reason ? { reason } : {}) });
    slot.listeners.clear();
  }

  status(flowId: string): LoginStatusResult {
    this.sweep();
    const slot = this.flows.get(flowId);
    if (!slot) return { status: 'expired' };
    return {
      status: slot.status,
      serverName: slot.serverName,
      ...(slot.reason ? { reason: slot.reason } : {}),
    };
  }

  cancel(flowId: string): void {
    const slot = this.flows.get(flowId);
    if (slot) this.settle(slot, 'cancelled');
  }

  /** Calls `cb` once when the flow settles. Already settled or unknown: called at once. */
  onSettled(flowId: string, cb: (s: LoginSettlement) => void): void {
    const slot = this.flows.get(flowId);
    if (!slot) {
      this.notify(cb, { status: 'expired' });
    } else if (slot.status !== 'pending') {
      this.notify(cb, { status: slot.status, ...(slot.reason ? { reason: slot.reason } : {}) });
    } else {
      slot.listeners.add(cb);
    }
  }

  get(flowId: string): Slot | undefined {
    return this.flows.get(flowId);
  }

  /** Abort every pending flow (host shutdown). */
  dispose(): void {
    for (const slot of [...this.flows.values()]) this.settle(slot, 'cancelled');
  }

  private notify(cb: (s: LoginSettlement) => void, s: LoginSettlement): void {
    try {
      cb(s);
    } catch (err) {
      this.logger.warn('mcp.oauth.login_listener_failed', {
        component: 'tools-mcp',
        event: 'mcp.oauth.login_listener_failed',
        err,
      });
    }
  }

  private emit(slot: Slot, outcome: LoginAuditEvent['outcome'], code?: string): void {
    const event: LoginAuditEvent = {
      server: slot.serverName,
      ...(slot.personalityId !== undefined ? { personalityId: slot.personalityId } : {}),
      flow: slot.kind,
      surface: slot.surface,
      ...(slot.authHost ? { authHost: slot.authHost } : {}),
      outcome,
      ...(code ? { code } : {}),
      ...(outcome !== 'started' && outcome !== 'refused'
        ? { polls: slot.polls, durationMs: this.now() - slot.startedAt }
        : {}),
    };
    this.logger.info('mcp.oauth.login', {
      component: 'tools-mcp',
      event: 'mcp.oauth.login',
      ...event,
    });
    this.recordEvent?.(event);
  }
}
