// P8 delegation containment (plan §5 P8 / §17 Phase 6, the phase's security gate).
//
// A mesh where A→B→A must be bounded TWO independent ways, because either alone
// is insufficient:
//
//   1. CALL DEPTH, in-envelope + signed. The trace id and depth counter travel
//      inside a DOMAIN-SEPARATED struct { context:'a2a-delegation', trace_id,
//      depth } signed by the CALLER with its Ed25519 key — NOT a plain mutable
//      header a malicious peer (or a proxy) can reset to 0 on each hop. The
//      server verifies the SIGNATURE and reads the SIGNED depth; a plain `depth`
//      header is never consulted. An inbound request whose signed depth ≥
//      MAX_DEPTH is rejected. When this agent makes an OUTBOUND call while
//      handling an inbound task, it signs a FRESH envelope at depth+1 with its
//      OWN key (see {@link signDelegation}).
//
//   2. GLOBAL per-task FAN-OUT budget. Depth alone is not enough: a depth-1 tree
//      that is very WIDE still lets one inbound task spawn thousands of outbound
//      calls (DoS + amplification). Per `trace_id`, we bound the TOTAL number of
//      outbound calls spawned while handling one inbound task. This is the
//      backstop against a peer that LIES about depth (always signs depth 0) — it
//      cannot lie its way past the fan-out counter.
//
// Layer-clean: imports only `./crypto` (Node Ed25519) — no types, no hono.

import { randomUUID } from 'node:crypto';
import { signStruct, verifyStruct } from './crypto';

export const A2A_DELEGATION_CONTEXT = 'a2a-delegation' as const;

/** The domain-separated struct a caller signs to carry trace id + depth. */
export interface A2aDelegationStruct {
  context: typeof A2A_DELEGATION_CONTEXT;
  trace_id: string;
  depth: number;
}

/**
 * The delegation credentials the server reads off an inbound request. All three
 * fields present → a signed envelope to verify. All three absent → a fresh
 * top-level call (a new trace, depth 0). A partial set is malformed.
 *
 * NOTE: `depth` here is the value that was SIGNED (echoed so the server can
 * reconstruct the struct and verify it). It is NOT a plain, independently
 * mutable header — the signature binds it.
 */
export interface A2aDelegationCredentials {
  traceId: string | null;
  depth: number | null;
  /** base64 Ed25519 signature over {@link A2aDelegationStruct}. */
  signature: string | null;
}

export type DelegationAdmission =
  | { ok: true; traceId: string; depth: number }
  | { ok: false; reason: string };

export interface A2aDelegationGuardOptions {
  /** Reject an inbound request at signed depth ≥ this. Default 3. */
  maxDepth?: number;
  /** Max TOTAL outbound calls per inbound task (per trace id). Default 8. */
  fanOutBudget?: number;
}

/**
 * Enforces both delegation bounds. One instance is shared per process so the
 * fan-out counters persist across requests within a trace.
 */
export class A2aDelegationGuard {
  readonly maxDepth: number;
  readonly fanOutBudget: number;
  // trace id → count of outbound calls already reserved under it.
  private readonly fanOut = new Map<string, number>();

  constructor(opts: A2aDelegationGuardOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 3;
    this.fanOutBudget = opts.fanOutBudget ?? 8;
  }

  /**
   * Admit an inbound request. Verifies the signed envelope against the CALLER's
   * public key and enforces the depth ceiling. A plain (unsigned) depth header
   * is intentionally not an input to this method — only the signed value counts.
   */
  admitInbound(creds: A2aDelegationCredentials, callerPublicKey: Buffer): DelegationAdmission {
    const { traceId, depth, signature } = creds;
    const allNull = traceId === null && depth === null && signature === null;
    if (allNull) {
      // Fresh top-level call: mint a new trace at depth 0.
      return { ok: true, traceId: randomUUID(), depth: 0 };
    }
    if (traceId === null || depth === null || signature === null) {
      return { ok: false, reason: 'incomplete delegation envelope' };
    }
    if (!Number.isInteger(depth) || depth < 0) {
      return { ok: false, reason: 'malformed delegation depth' };
    }
    const struct: A2aDelegationStruct = {
      context: A2A_DELEGATION_CONTEXT,
      trace_id: traceId,
      depth,
    };
    if (!verifyStruct(struct, signature, callerPublicKey)) {
      return { ok: false, reason: 'delegation signature invalid' };
    }
    if (depth >= this.maxDepth) {
      return { ok: false, reason: `delegation depth ${depth} exceeds max ${this.maxDepth}` };
    }
    return { ok: true, traceId, depth };
  }

  /**
   * Reserve ONE outbound call against a trace's fan-out budget. Returns false
   * once the budget is exhausted — the caller must NOT make the outbound call.
   * The backstop against a peer that lies about depth.
   */
  reserveOutbound(traceId: string): boolean {
    const used = this.fanOut.get(traceId) ?? 0;
    if (used >= this.fanOutBudget) return false;
    this.fanOut.set(traceId, used + 1);
    return true;
  }

  /** Drop a trace's fan-out counter once its inbound task has settled. */
  releaseTrace(traceId: string): void {
    this.fanOut.delete(traceId);
  }
}

/**
 * Sign an outbound delegation envelope at `depth` with the caller's Ed25519 key
 * (PKCS8 PEM). Used by the outbound path (Phase 7) — when this agent calls a
 * peer while handling an inbound task at depth D, it signs depth D+1.
 */
export function signDelegation(traceId: string, depth: number, privateKeyPem: string): string {
  const struct: A2aDelegationStruct = {
    context: A2A_DELEGATION_CONTEXT,
    trace_id: traceId,
    depth,
  };
  return signStruct(struct, privateKeyPem);
}

/**
 * Build the full delegation credentials for an outbound call at `depth`. A
 * convenience over {@link signDelegation} for the outbound client + tests.
 */
export function buildDelegationCredentials(
  traceId: string,
  depth: number,
  privateKeyPem: string,
): A2aDelegationCredentials {
  return { traceId, depth, signature: signDelegation(traceId, depth, privateKeyPem) };
}
