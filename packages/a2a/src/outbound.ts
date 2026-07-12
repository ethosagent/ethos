// A2A OUTBOUND client (plan §7 Phase 7) — this agent calling a PEER as the
// initiator. It is the mirror of the inbound server (auth.ts + rpc.ts): it never
// re-implements the server's crypto or handshake, it drives them from the other
// side of the wire, reusing the SAME domain-separated structs so signer and
// verifier can never drift.
//
// Flow:
//   1. connect  — fetch + verify the peer's card (fetchAndVerifyCard), then run
//                 the two-step auth handshake (challenge → response) to obtain a
//                 sender-constrained token.
//   2. sendMessage — mint a per-request proof-of-possession over the token's jti
//                 and POST a JSON-RPC 2.0 `message/send`. When servicing an
//                 inbound A2A task, it signs a FRESH delegation envelope at
//                 depth+1 and consumes the per-trace fan-out budget (P8).
//
// Layer purity: imports ONLY `@ethosagent/types` (the AgentCard TYPE), `jose`
// (decodeJwt — an UNVERIFIED read of MY OWN token's jti), `node:crypto`
// (randomUUID), and sibling `./` modules. NO core, NO extensions, NO apps.

import { randomUUID } from 'node:crypto';
import type { AgentCard } from '@ethosagent/types';
import { decodeJwt } from 'jose';
import type { A2aChallengeStruct, ChallengeRequest, ChallengeResponse } from './auth';
import { fetchAndVerifyCard } from './client';
import { signStruct } from './crypto';
import { buildDelegationCredentials } from './delegation';
import {
  A2A_METHOD_MESSAGE_SEND,
  A2A_REQUEST_POP_CONTEXT,
  type A2aMessageSendParams,
  type A2aRequestPopStruct,
} from './rpc';

/** An established A2A session with a peer: the verified card + a live token. */
export interface A2aSession {
  peerCard: AgentCard;
  /** The sender-constrained access token this agent holds for the peer. */
  token: string;
  /** ms epoch the token expires. */
  expiresAt: number;
}

/**
 * The delegation frame threaded onto an outbound call when this agent is
 * servicing an inbound A2A task (plan §P8). `reserveOutbound` is the guard's
 * per-trace fan-out check, passed as a bare function so the outbound client
 * never couples to `A2aDelegationGuard`.
 */
export interface OutboundDelegation {
  traceId: string;
  /** The depth THIS agent was admitted at; the onward call signs `depth + 1`. */
  depth: number;
  /** Reserve one outbound call against the trace budget; `false` → exhausted. */
  reserveOutbound?: () => boolean;
}

/** Typed result of {@link A2aOutboundClient.sendMessage}. */
export type A2aOutboundResult =
  | {
      ok: true;
      mode: 'sync';
      taskId: string;
      state: 'completed' | 'failed';
      text: string;
      error?: string;
    }
  | { ok: true; mode: 'async'; taskId: string; status: string }
  | { ok: false; code: number; message: string };

/** Discriminated failure reasons for the outbound path. */
export type A2aOutboundErrorCode =
  | 'fanout_exhausted'
  | 'fetch_failed'
  | 'invalid_response'
  | 'self_loop_forbidden';

/** Typed error thrown by {@link A2aOutboundClient} — mirrors {@link import('./client').A2aClientError}. */
export class A2aOutboundError extends Error {
  readonly code: A2aOutboundErrorCode;
  constructor(code: A2aOutboundErrorCode, message: string) {
    super(message);
    this.name = 'A2aOutboundError';
    this.code = code;
  }
}

export interface A2aOutboundClientDeps {
  /** Inject a `fetch` implementation (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
}

export interface ConnectArgs {
  /** The peer's well-known Agent Card URL. */
  wellKnownUrl: string;
  /** Out-of-band trust anchor (plan §7); when set the card fingerprint MUST match. */
  expectedFingerprint?: string;
  /** THIS agent's signed card, presented in the challenge. */
  myCard: AgentCard;
  /** THIS agent's Ed25519 private key (PKCS8 PEM) — signs the challenge response. */
  myPrivateKeyPem: string;
  /**
   * Allow calling my OWN agent (peer fingerprint == my fingerprint). Default
   * false: a same-box self-loop is refused (plan §14 MESH guard). An external
   * peer and "myself" are indistinguishable to the server, so a self-loop pays
   * the full network/TLS/auth tax and muddies the trust model — it is opt-in
   * behind an explicit flag.
   */
  allowSelfLoop?: boolean;
}

export interface SendMessageArgs {
  session: A2aSession;
  /** Defaults to `session.peerCard.endpoints.jsonRpc`. */
  jsonRpcUrl?: string;
  /** THIS agent's Ed25519 private key (PKCS8 PEM) — signs the PoP + delegation. */
  myPrivateKeyPem: string;
  skill: string;
  message: string;
  mode?: 'sync' | 'async';
  sessionKey?: string;
  idempotencyKey?: string;
  /** Present when this call is spawned while servicing an inbound A2A task (P8). */
  delegation?: OutboundDelegation;
}

/**
 * The outbound A2A client. Constructed with injected deps so it is deterministic
 * in tests; a single instance can drive many peers (state lives in {@link A2aSession}).
 */
export class A2aOutboundClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(deps: A2aOutboundClientDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Fetch + verify the peer's card, then run the auth handshake for a token. */
  async connect(args: ConnectArgs): Promise<A2aSession> {
    const peerCard = await fetchAndVerifyCard(args.wellKnownUrl, {
      ...(args.expectedFingerprint ? { expectedFingerprint: args.expectedFingerprint } : {}),
      fetchImpl: this.fetchImpl,
    });

    // Self-loop guard (plan §14): refuse calling my own agent unless explicitly
    // allowed. Checked here — the first point where BOTH fingerprints are known.
    if (!args.allowSelfLoop && peerCard.keyFingerprint === args.myCard.keyFingerprint) {
      throw new A2aOutboundError(
        'self_loop_forbidden',
        'refusing to call my own agent (self-loop disabled by default)',
      );
    }

    const authEndpoint = peerCard.endpoints.auth;

    // Step 2: challenge — present my card, receive a single-use nonce.
    const challengeBody: ChallengeRequest = { card: args.myCard };
    const challenge = await this.postJson(`${authEndpoint}/challenge`, challengeBody, false);
    if (!isChallengeIssue(challenge)) {
      throw new A2aOutboundError('invalid_response', 'malformed challenge response from peer');
    }

    // Step 3: response — sign the DOMAIN-SEPARATED challenge struct + return it.
    const struct: A2aChallengeStruct = {
      context: 'a2a-auth-challenge',
      nonce: challenge.nonce,
      target_agent_id: challenge.target_agent_id,
      timestamp: this.now(),
    };
    const responseBody: ChallengeResponse = {
      nonce: struct.nonce,
      timestamp: struct.timestamp,
      signature: signStruct(struct, args.myPrivateKeyPem),
      fingerprint: args.myCard.keyFingerprint,
    };
    const minted = await this.postJson(`${authEndpoint}/response`, responseBody, false);
    if (!isTokenIssue(minted)) {
      throw new A2aOutboundError('invalid_response', 'malformed token response from peer');
    }

    return { peerCard, token: minted.token, expiresAt: minted.expiresAt };
  }

  /** Send a `message/send` to the peer under an established session. */
  async sendMessage(args: SendMessageArgs): Promise<A2aOutboundResult> {
    const jsonRpcUrl = args.jsonRpcUrl ?? args.session.peerCard.endpoints.jsonRpc;

    // Per-request proof-of-possession over the token's jti (an unverified read
    // of MY OWN token — I am only echoing its jti into the signed struct).
    const jti = decodeJwt(args.session.token).jti;
    if (typeof jti !== 'string') {
      throw new A2aOutboundError('invalid_response', 'session token is missing a jti');
    }
    const timestamp = this.now();
    const popStruct: A2aRequestPopStruct = {
      context: A2A_REQUEST_POP_CONTEXT,
      method: A2A_METHOD_MESSAGE_SEND,
      jti,
      timestamp,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${args.session.token}`,
      'x-a2a-pop': signStruct(popStruct, args.myPrivateKeyPem),
      'x-a2a-pop-timestamp': String(timestamp),
    };

    // Delegation containment (P8): when spawned while servicing an inbound task,
    // consume the per-trace fan-out budget and sign a FRESH envelope at depth+1.
    if (args.delegation) {
      const { traceId, depth, reserveOutbound } = args.delegation;
      if (reserveOutbound && !reserveOutbound()) {
        throw new A2aOutboundError(
          'fanout_exhausted',
          `fan-out budget exhausted for trace ${traceId}`,
        );
      }
      const nextDepth = depth + 1;
      const creds = buildDelegationCredentials(traceId, nextDepth, args.myPrivateKeyPem);
      if (creds.signature) {
        headers['x-a2a-trace-id'] = traceId;
        headers['x-a2a-delegation-depth'] = String(nextDepth);
        headers['x-a2a-delegation-sig'] = creds.signature;
      }
    }

    const params: A2aMessageSendParams = {
      skill: args.skill,
      message: args.message,
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.sessionKey ? { sessionKey: args.sessionKey } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    };
    const body = {
      jsonrpc: '2.0' as const,
      id: randomUUID(),
      method: A2A_METHOD_MESSAGE_SEND,
      params,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(jsonRpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new A2aOutboundError('fetch_failed', `POST ${jsonRpcUrl} failed: ${reason}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new A2aOutboundError('invalid_response', 'peer returned a non-JSON JSON-RPC response');
    }

    if (isJsonRpcError(json)) {
      return { ok: false, code: json.error.code, message: json.error.message };
    }
    if (!isJsonRpcResult(json)) {
      throw new A2aOutboundError('invalid_response', 'malformed JSON-RPC response envelope');
    }

    const mode = args.mode ?? 'sync';
    if (mode === 'async') {
      if (!isAsyncSubmit(json.result)) {
        throw new A2aOutboundError('invalid_response', 'malformed async submit result');
      }
      return { ok: true, mode: 'async', taskId: json.result.taskId, status: json.result.status };
    }
    if (!isSyncTaskResult(json.result)) {
      throw new A2aOutboundError('invalid_response', 'malformed sync task result');
    }
    const result = json.result;
    return {
      ok: true,
      mode: 'sync',
      taskId: result.taskId,
      state: result.state,
      text: result.text,
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
    };
  }

  /** POST JSON and return the parsed body. `rpc` requests stay HTTP 200; the
   *  handshake returns non-2xx on rejection, so `allowNonOk` gates it. */
  private async postJson(url: string, body: unknown, allowNonOk: boolean): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new A2aOutboundError('fetch_failed', `POST ${url} failed: ${reason}`);
    }
    if (!allowNonOk && !response.ok) {
      throw new A2aOutboundError('invalid_response', `${url} returned HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new A2aOutboundError('invalid_response', `${url} returned a non-JSON body`);
    }
  }
}

// ---------------------------------------------------------------------------
// Structural guards — external JSON is never cast with `as` (project rule).
// ---------------------------------------------------------------------------

function isChallengeIssue(value: unknown): value is { nonce: string; target_agent_id: string } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.nonce === 'string' && typeof v.target_agent_id === 'string';
}

function isTokenIssue(value: unknown): value is { token: string; expiresAt: number } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === 'string' && typeof v.expiresAt === 'number';
}

function isJsonRpcError(value: unknown): value is { error: { code: number; message: string } } {
  if (value === null || typeof value !== 'object') return false;
  const err = (value as Record<string, unknown>).error;
  if (err === null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'number' && typeof e.message === 'string';
}

function isJsonRpcResult(value: unknown): value is { result: unknown } {
  return value !== null && typeof value === 'object' && 'result' in value;
}

function isSyncTaskResult(
  value: unknown,
): value is { taskId: string; state: 'completed' | 'failed'; text: string; error?: unknown } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.taskId === 'string' &&
    (v.state === 'completed' || v.state === 'failed') &&
    typeof v.text === 'string'
  );
}

function isAsyncSubmit(value: unknown): value is { taskId: string; status: string } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.taskId === 'string' && typeof v.status === 'string';
}
