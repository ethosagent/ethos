// A2A JSON-RPC server + execute-task wrap (Phase 5, plan §5/§10/§12).
//
// The `/a2a/<personalityId>` endpoint is the authenticated talk surface. It is
// mounted `public` through the Phase-2 RouteModule seam and owns its OWN access
// control — it does NOT ride the main API's cookie/bearer auth, because an A2A
// caller presents an A2A-minted EdDSA JWT plus a per-request proof-of-possession,
// neither of which is the web-api credential. Every failure is a JSON-RPC error
// envelope (HTTP stays 200, per JSON-RPC-over-HTTP).
//
// Three gates, in order (plan §4 / P3 / P5):
//   1. TOKEN      — the sender-constrained JWT validates (jose sig + exp + cnf +
//                   revocation gate against the peer store).
//   2. PoP        — a per-request signature over the DOMAIN-SEPARATED struct
//                   { context:'a2a-request-pop', method, jti, timestamp } verifies
//                   against the token's bound peer key (`cnf.jkt`). A stolen token
//                   WITHOUT the peer's private key cannot produce this → REJECT.
//                   Replay-guarded: short timestamp window + single-use signature.
//   3. SCOPE      — the requested `skill` must be in BOTH the token's granted
//                   scope AND the personality's CURRENT character sheet, re-read
//                   via `getIdentity(...,'trusted-peer')` AT CALL TIME (never
//                   cached at grant). Removing the skill revokes it immediately.
//
// The task itself is the existing loop wrapped thinly: an injected
// `A2aTaskRunner` (mirrors ACP's `AgentRunner`) yields the 8-variant AgentEvent
// stream; sync path collects `text_delta` → final text, `done` → completed,
// `error` → failed. thinking_delta is a working update, NEVER surfaced to the
// peer (internal reasoning must not leak across the trust boundary).
//
// Layer-clean: imports only `@ethosagent/types` (the AgentEvent TYPE + the
// identity contract), `hono`, `jose`, and sibling `./` modules (which bottom out
// at `node:crypto`). No core, no extensions, no apps — the runner is injected.

import { randomUUID } from 'node:crypto';
import { type A2aIdentityProvider, type AgentEvent, EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { fingerprint, verifyStruct } from './crypto';
import type { A2aPeerStore } from './stores';
import { validateToken } from './tokens';

// ---------------------------------------------------------------------------
// Injected task runner — mirrors ACP's `AgentRunner` (apps/acp-server).
// ---------------------------------------------------------------------------

/**
 * The execute-task seam. `packages/a2a` consumes the AgentEvent stream and maps
 * it to a task result; it NEVER imports core. The serve/web-api wiring provides
 * the concrete impl that calls the real `AgentLoop.run` (plan §2 / §10, mirrors
 * how ACP wires its runner to the loop).
 */
export interface A2aTaskRunner {
  run(
    personalityId: string,
    text: string,
    opts?: { sessionKey?: string },
  ): AsyncIterable<AgentEvent>;
}

// ---------------------------------------------------------------------------
// Isolatable limiter hook (plan §12 blast-radius mitigation seam).
// ---------------------------------------------------------------------------

/**
 * Optional per-request limiter (rate + concurrency). A no-op default ships now;
 * full caps are Phase 6. `acquire` returns a lease to release when the task
 * finishes, or `null` to reject the request (rate/concurrency exceeded). This is
 * the §12 seam that keeps A2A abuse from taking down the rest of the API even
 * though it is mounted in-process.
 */
export interface A2aLimiter {
  acquire(personalityId: string, peerFingerprint: string): Promise<A2aLease | null>;
}

export interface A2aLease {
  release(): void;
}

const NOOP_LIMITER: A2aLimiter = {
  async acquire() {
    return { release() {} };
  },
};

// ---------------------------------------------------------------------------
// Per-request proof-of-possession (plan §0A / §9, completes the Phase-4
// sender-constraint end-to-end).
// ---------------------------------------------------------------------------

export const A2A_REQUEST_POP_CONTEXT = 'a2a-request-pop' as const;

/** The domain-separated struct the peer signs on every `/a2a` request. */
export interface A2aRequestPopStruct {
  context: typeof A2A_REQUEST_POP_CONTEXT;
  /** The JSON-RPC method being called (binds the proof to this call). */
  method: string;
  /** The presented token's id — a proof for token T is useless for token T'. */
  jti: string;
  /** ms epoch — replay-guarded by a short window + single-use. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope + error codes.
// ---------------------------------------------------------------------------

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

/** JSON-RPC method name for A2A `tasks/send` (plan §10). */
export const A2A_METHOD_MESSAGE_SEND = 'message/send' as const;

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // Application errors (JSON-RPC server-defined range).
  EXECUTION_FAILED: -32000,
  UNAUTHORIZED: -32001,
  PROOF_INVALID: -32002,
  FORBIDDEN_SCOPE: -32003,
  RATE_LIMITED: -32004,
} as const;

// ---------------------------------------------------------------------------
// Request credentials + params.
// ---------------------------------------------------------------------------

/** Credentials pulled off the HTTP request by the router (or a test). */
export interface A2aRequestCredentials {
  /** The A2A access token (the `Authorization: Bearer <token>` value). */
  token: string | null;
  /** base64 Ed25519 signature over the {@link A2aRequestPopStruct}. */
  proofSignature: string | null;
  /** ms epoch echoed from the signed proof struct. */
  proofTimestamp: number | null;
}

/** `message/send` params (sync path). */
export interface A2aMessageSendParams {
  /** Target capability — enforced against scope ∩ current character sheet. */
  skill: string;
  /** The message text handed to the agent loop. */
  message: string;
  /** Optional session key; defaults to `a2a:<personalityId>:<peerFingerprint>`. */
  sessionKey?: string;
}

/** The sync task result returned as the JSON-RPC `result`. */
export interface A2aTaskResult {
  taskId: string;
  state: 'completed' | 'failed';
  text: string;
  /** Present when `state === 'failed'`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Service.
// ---------------------------------------------------------------------------

export interface A2aRpcServiceOptions {
  /**
   * Read-only identity projection. Re-read AT CALL TIME for the current
   * character sheet (scope ∩) and the target public key that validates tokens.
   * Injected — this package never imports the personalities extension.
   */
  getIdentity: A2aIdentityProvider;
  /** Peer store — recovers the bound peer key for PoP + the revocation gate. */
  peerStore: A2aPeerStore;
  /** The execute-task seam (injected AgentLoop wrapper). */
  runner: A2aTaskRunner;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /** PoP timestamp window in ms (replay guard). Default 60_000. */
  popWindowMs?: number;
  /** Isolatable limiter (plan §12). Default no-op. */
  limiter?: A2aLimiter;
}

export interface A2aRpcService {
  handleRpc(
    personalityId: string,
    request: unknown,
    creds: A2aRequestCredentials,
  ): Promise<JsonRpcResponse>;
}

export function createA2aRpcService(opts: A2aRpcServiceOptions): A2aRpcService {
  const now = opts.now ?? Date.now;
  const popWindowMs = opts.popWindowMs ?? 60_000;
  const limiter = opts.limiter ?? NOOP_LIMITER;

  // Single-use PoP signatures within the window (replay guard, plan §9). Keyed
  // by the signature; value is the ms-epoch expiry. In-process for the single-
  // process v1 — moves to shared storage if the server scales out (same note as
  // the nonce store).
  const usedProofs = new Map<string, number>();
  function sweepProofs(nowMs: number): void {
    for (const [sig, exp] of usedProofs) {
      if (exp <= nowMs) usedProofs.delete(sig);
    }
  }

  async function handleRpc(
    personalityId: string,
    request: unknown,
    creds: A2aRequestCredentials,
  ): Promise<JsonRpcResponse> {
    if (!isJsonRpcRequest(request)) {
      return errorResponse(null, RPC.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request');
    }
    const id = request.id ?? null;

    if (request.method !== A2A_METHOD_MESSAGE_SEND) {
      return errorResponse(id, RPC.METHOD_NOT_FOUND, `method not found: ${request.method}`);
    }
    if (!isMessageSendParams(request.params)) {
      return errorResponse(id, RPC.INVALID_PARAMS, 'invalid message/send params');
    }
    const params = request.params;

    // --- Gate 1: token -----------------------------------------------------
    if (!creds.token) {
      return errorResponse(id, RPC.UNAUTHORIZED, 'missing access token');
    }
    // Peek the sender-constraint fingerprint (unverified) to drive validation;
    // validateToken then does the real crypto (sig + exp + cnf + revocation).
    const jkt = peekCnfJkt(creds.token);
    if (jkt === null) {
      return errorResponse(id, RPC.UNAUTHORIZED, 'malformed token or missing sender-constraint');
    }

    // Current identity — one read serves BOTH the target public key (validates
    // the token) AND the current character-sheet skills (scope ∩, at call time).
    let targetPublicKey: Buffer;
    let sheetSkills: Set<string>;
    try {
      const card = await opts.getIdentity.getIdentity(personalityId, 'trusted-peer');
      targetPublicKey = Buffer.from(card.publicKey, 'base64');
      sheetSkills = new Set(card.skills.map((s) => s.name));
    } catch (err) {
      if (err instanceof EthosError && err.code === 'PERSONALITY_NOT_FOUND') {
        return errorResponse(id, RPC.UNAUTHORIZED, `unknown personality "${personalityId}"`);
      }
      return errorResponse(id, RPC.INTERNAL, 'identity lookup failed');
    }

    const validation = await validateToken(creds.token, {
      targetPublicKey,
      presentedFingerprint: jkt,
      issuer: personalityId,
      audience: personalityId,
      now: now(),
      peerStore: opts.peerStore,
      personalityId,
    });
    if (!validation.ok) {
      return errorResponse(id, RPC.UNAUTHORIZED, `token rejected: ${validation.reason}`);
    }
    const claims = validation.claims;

    // --- Gate 2: per-request proof-of-possession ---------------------------
    if (!creds.proofSignature || creds.proofTimestamp === null) {
      return errorResponse(id, RPC.PROOF_INVALID, 'missing proof-of-possession');
    }
    const nowMs = now();
    if (Math.abs(nowMs - creds.proofTimestamp) > popWindowMs) {
      return errorResponse(id, RPC.PROOF_INVALID, 'proof timestamp outside allowed window');
    }
    sweepProofs(nowMs);
    if (usedProofs.has(creds.proofSignature)) {
      return errorResponse(id, RPC.PROOF_INVALID, 'proof already used (replay)');
    }
    // Recover the bound peer key from the store to verify the proof against it.
    const entry = await opts.peerStore.get(personalityId, jkt);
    if (!entry) {
      return errorResponse(id, RPC.UNAUTHORIZED, 'unknown peer');
    }
    const peerPublicKey = Buffer.from(entry.card.publicKey, 'base64');
    if (fingerprint(peerPublicKey) !== jkt) {
      return errorResponse(id, RPC.UNAUTHORIZED, 'peer key/fingerprint mismatch');
    }
    const popStruct: A2aRequestPopStruct = {
      context: A2A_REQUEST_POP_CONTEXT,
      method: request.method,
      jti: claims.jti,
      timestamp: creds.proofTimestamp,
    };
    if (!verifyStruct(popStruct, creds.proofSignature, peerPublicKey)) {
      return errorResponse(id, RPC.PROOF_INVALID, 'proof-of-possession signature invalid');
    }
    // Burn the proof only once it is proven valid (single-use within the window).
    usedProofs.set(creds.proofSignature, nowMs + popWindowMs);

    // --- Gate 3: scope ∩ current character sheet (evaluated at call time) ---
    const skill = params.skill;
    if (!claims.scope.includes(skill)) {
      return errorResponse(id, RPC.FORBIDDEN_SCOPE, `skill "${skill}" not in granted scope`);
    }
    if (!sheetSkills.has(skill)) {
      return errorResponse(
        id,
        RPC.FORBIDDEN_SCOPE,
        `skill "${skill}" not in the personality's current character sheet`,
      );
    }

    // --- Execute (isolatable limiter around the run) -----------------------
    const lease = await limiter.acquire(personalityId, jkt);
    if (!lease) {
      return errorResponse(id, RPC.RATE_LIMITED, 'rate or concurrency limit exceeded');
    }
    try {
      const sessionKey = params.sessionKey ?? `a2a:${personalityId}:${jkt}`;
      const result = await runTask(opts.runner, personalityId, params.message, sessionKey);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(id, RPC.EXECUTION_FAILED, `task execution failed: ${message}`);
    } finally {
      lease.release();
    }
  }

  return { handleRpc };
}

/**
 * Consume the AgentEvent stream (sync path): accumulate `text_delta` as the
 * final text; `done` → completed (its `text` is the fallback final); `error` →
 * failed. `thinking_delta` and tool events are working updates and are NOT
 * surfaced to the peer — internal reasoning must not cross the trust boundary.
 */
async function runTask(
  runner: A2aTaskRunner,
  personalityId: string,
  text: string,
  sessionKey: string,
): Promise<A2aTaskResult> {
  const taskId = randomUUID();
  let out = '';
  let doneText: string | null = null;
  let failure: string | undefined;

  for await (const event of runner.run(personalityId, text, { sessionKey })) {
    switch (event.type) {
      case 'text_delta':
        out += event.text;
        break;
      case 'done':
        doneText = event.text;
        break;
      case 'error':
        failure = event.error;
        break;
      default:
        // thinking_delta, tool_*, usage, halt, … → working updates, not surfaced.
        break;
    }
  }

  const finalText = out.length > 0 ? out : (doneText ?? '');
  if (failure !== undefined) {
    return { taskId, state: 'failed', text: finalText, error: failure };
  }
  return { taskId, state: 'completed', text: finalText };
}

// ---------------------------------------------------------------------------
// Router — thin HTTP adapter over the service.
// ---------------------------------------------------------------------------

/**
 * Build the `/a2a` Hono sub-router. Routes are RELATIVE to the RouteModule
 * basePath `/a2a` (the seam mounts it with `app.route('/a2a', router)`,
 * `auth: 'public'`), yielding:
 *
 *   POST /a2a/:personalityId   JSON-RPC 2.0 (method `message/send`)
 *
 * The token rides `Authorization: Bearer <token>`; the per-request proof rides
 * `X-A2A-PoP` (signature) + `X-A2A-PoP-Timestamp` (ms epoch). Every decision
 * lives in {@link A2aRpcService} so the attack tests exercise it without HTTP.
 */
export function createA2aRpcRouter(opts: A2aRpcServiceOptions): Hono {
  const service = createA2aRpcService(opts);
  const router = new Hono();

  router.post('/:personalityId', async (c) => {
    const personalityId = c.req.param('personalityId');

    const authz = c.req.header('authorization');
    const token = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : null;
    const proofSignature = c.req.header('x-a2a-pop') ?? null;
    const tsRaw = c.req.header('x-a2a-pop-timestamp');
    const proofTimestamp = tsRaw !== undefined && /^\d+$/.test(tsRaw) ? Number(tsRaw) : null;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorResponse(null, RPC.PARSE_ERROR, 'parse error'));
    }

    const response = await service.handleRpc(personalityId, body, {
      token,
      proofSignature,
      proofTimestamp,
    });
    return c.json(response);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Peek `cnf.jkt` from an UNVERIFIED token (validateToken does the real check). */
function peekCnfJkt(token: string): string | null {
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwt(token);
  } catch {
    return null;
  }
  const cnf = payload.cnf;
  if (cnf === null || typeof cnf !== 'object') return null;
  const jkt = (cnf as Record<string, unknown>).jkt;
  return typeof jkt === 'string' ? jkt : null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && typeof v.method === 'string';
}

function isMessageSendParams(value: unknown): value is A2aMessageSendParams {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.skill !== 'string' || v.skill.length === 0) return false;
  if (typeof v.message !== 'string') return false;
  if (v.sessionKey !== undefined && typeof v.sessionKey !== 'string') return false;
  return true;
}
