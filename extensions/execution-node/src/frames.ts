/**
 * Wire frames for the laptop tool node (plan/phases/laptop-tool-node.md §3.4).
 *
 * JSON text frames carrying `v: 1`. Both ends decode with the hand-written
 * validators below: every decoder builds a NEW object field by field, so
 * unknown fields are dropped and nothing is cast with `as`. Pinned by
 * extensions/execution-node/src/__tests__/frames.test.ts.
 */
import type { ToolExecuteRequest, ToolResult } from '@ethosagent/types';

export const NODE_PROTOCOL_VERSION = 1;
export const NODE_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const NODE_SOCKET_PATH = '/node/ws';
export const NODE_PAIR_PATH = '/node/pair';
export const NODE_HOST_SCOPE = 'node:host';
/** Longest callId a peer may send; enforced by `isCallId` in decodeServerFrame (frames.test.ts). */
export const NODE_CALL_ID_MAX = 128;
export const NODE_DISCONNECTED = 'node_disconnected';
export const NODE_CLOSE = { normal: 1000, badFrame: 1008, replaced: 4000, revoked: 4401 } as const;

export interface NodeRootAdvert {
  path: string;
  readOnly: boolean;
}
/** The one root shape: what a node enforces and what it advertises (D19). */
export type NodeRoot = NodeRootAdvert;
/** A node name; the same rule as the key row `node:<name>` (verification D-REPAIR). */
export const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
export interface HelloFrame {
  v: 1;
  kind: 'hello';
  /** Informational: the server labels a node from its key row (apps/web-api/src/node/node-socket.ts). */
  name: string;
  roots: NodeRootAdvert[];
  tools: string[];
  personalities: string[];
  clock: number;
}
export interface CallFrame {
  v: 1;
  kind: 'call';
  callId: string;
  deadline: number;
  request: ToolExecuteRequest;
}
export interface ProgressFrame {
  v: 1;
  kind: 'progress';
  callId: string;
  message: string;
  audience?: 'internal' | 'user' | 'dashboard';
}
export interface ResultFrame {
  v: 1;
  kind: 'result';
  callId: string;
  result: ToolResult;
}
export interface CancelFrame {
  v: 1;
  kind: 'cancel';
  callId: string;
}
export interface PingFrame {
  v: 1;
  kind: 'ping';
  at: number;
}
export interface PongFrame {
  v: 1;
  kind: 'pong';
  at: number;
}
export interface PairRequestFrame {
  v: 1;
  kind: 'pair_request';
  name: string;
  roots: NodeRootAdvert[];
}
export interface PairPendingFrame {
  v: 1;
  kind: 'pair_pending';
  code: string;
  expiresAt: number;
}
export interface PairApprovedFrame {
  v: 1;
  kind: 'pair_approved';
  key: string;
  keyId: string;
}
export interface PairRefusedFrame {
  v: 1;
  kind: 'pair_refused';
  reason: string;
}

export type NodeToServerFrame = HelloFrame | ProgressFrame | ResultFrame | PingFrame | PongFrame;
export type ServerToNodeFrame = CallFrame | CancelFrame | PingFrame | PongFrame;
export type PairClientFrame = PairRequestFrame;
export type PairServerFrame = PairPendingFrame | PairApprovedFrame | PairRefusedFrame;
export type AnyNodeFrame =
  | NodeToServerFrame
  | ServerToNodeFrame
  | PairClientFrame
  | PairServerFrame;

export type Decoded<F> = { ok: true; frame: F } | { ok: false; reason: string };

export function encodeFrame(frame: AnyNodeFrame): string {
  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isCallId(v: unknown): v is string {
  return isString(v) && v.length <= NODE_CALL_ID_MAX;
}
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}
function optString(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return isString(v) ? v : null;
}

/** Bounds on advertised roots; pair_request is unauthenticated (verification m4). */
const ROOTS_MAX = 32;
const ROOT_PATH_MAX = 1024;

/** Bounded decode of advertised roots (frames, admin responses and saved node state). */
export function decodeRoots(v: unknown): NodeRootAdvert[] | null {
  if (!Array.isArray(v) || v.length > ROOTS_MAX) return null;
  const out: NodeRootAdvert[] = [];
  for (const item of v) {
    if (
      !isRecord(item) ||
      !isString(item.path) ||
      item.path.length > ROOT_PATH_MAX ||
      typeof item.readOnly !== 'boolean'
    ) {
      return null;
    }
    out.push({ path: item.path, readOnly: item.readOnly });
  }
  return out;
}

const OPTIONAL_REQUEST_STRINGS = [
  'personalityId',
  'teamId',
  'agentId',
  'rootSessionKey',
  'jobId',
  'reviewOfJobId',
  'origin',
  'memoryScopeId',
  'userScopeId',
] as const;

export function decodeToolExecuteRequest(value: unknown): ToolExecuteRequest | null {
  if (!isRecord(value)) return null;
  const { toolCallId, name, sessionId, sessionKey, platform, workingDir } = value;
  const { currentTurn, messageCount, resultBudgetChars } = value;
  if (
    !isString(toolCallId) ||
    !isString(name) ||
    !isString(sessionId) ||
    !isString(sessionKey) ||
    !isString(platform) ||
    !isString(workingDir) ||
    !isNumber(currentTurn) ||
    !isNumber(messageCount) ||
    !isNumber(resultBudgetChars)
  ) {
    return null;
  }
  const out: ToolExecuteRequest = {
    toolCallId,
    name,
    args: value.args,
    sessionId,
    sessionKey,
    platform,
    workingDir,
    currentTurn,
    messageCount,
    resultBudgetChars,
  };
  for (const key of OPTIONAL_REQUEST_STRINGS) {
    const s = optString(value[key]);
    if (s === null) return null;
    if (s !== undefined) out[key] = s;
  }
  if (value.roomAudience !== undefined) {
    if (value.roomAudience !== 'private' && value.roomAudience !== 'shared') return null;
    out.roomAudience = value.roomAudience;
  }
  if (value.initiator !== undefined) {
    if (value.initiator !== 'user' && value.initiator !== 'system') return null;
    out.initiator = value.initiator;
  }
  if (value.toolsetNarrowing !== undefined) {
    const t = value.toolsetNarrowing;
    if (!isRecord(t)) return null;
    const narrowing: { narrow?: string[]; exclude?: string[] } = {};
    if (t.narrow !== undefined) {
      if (!isStringArray(t.narrow)) return null;
      narrowing.narrow = [...t.narrow];
    }
    if (t.exclude !== undefined) {
      if (!isStringArray(t.exclude)) return null;
      narrowing.exclude = [...t.exclude];
    }
    out.toolsetNarrowing = narrowing;
  }
  if (value.networkPolicy !== undefined) {
    const n = value.networkPolicy;
    if (!isRecord(n)) return null;
    const policy: { allow?: string[]; deny?: string[]; allow_private_urls?: boolean } = {};
    if (n.allow !== undefined) {
      if (!isStringArray(n.allow)) return null;
      policy.allow = [...n.allow];
    }
    if (n.deny !== undefined) {
      if (!isStringArray(n.deny)) return null;
      policy.deny = [...n.deny];
    }
    if (n.allow_private_urls !== undefined) {
      if (typeof n.allow_private_urls !== 'boolean') return null;
      policy.allow_private_urls = n.allow_private_urls;
    }
    out.networkPolicy = policy;
  }
  if (value.dryRun !== undefined) {
    if (typeof value.dryRun !== 'boolean') return null;
    out.dryRun = value.dryRun;
  }
  return out;
}

export function decodeToolResult(value: unknown): ToolResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    if (!isString(value.value)) return null;
    const out: Extract<ToolResult, { ok: true }> = { ok: true, value: value.value };
    if (value.structured !== undefined) {
      if (!isRecord(value.structured)) return null;
      out.structured = { ...value.structured };
    }
    if (value.cost_usd !== undefined) {
      if (!isNumber(value.cost_usd)) return null;
      out.cost_usd = value.cost_usd;
    }
    return out;
  }
  if (value.ok !== false || !isString(value.error)) return null;
  const error = value.error;
  switch (value.code) {
    case 'input_invalid': {
      const field = optString(value.field);
      if (field === null) return null;
      return field === undefined
        ? { ok: false, code: 'input_invalid', error }
        : { ok: false, code: 'input_invalid', error, field };
    }
    case 'not_available': {
      const reason = optString(value.reason);
      if (reason === null) return null;
      return reason === undefined
        ? { ok: false, code: 'not_available', error }
        : { ok: false, code: 'not_available', error, reason };
    }
    case 'execution_failed':
      return value.cause === undefined
        ? { ok: false, code: 'execution_failed', error }
        : { ok: false, code: 'execution_failed', error, cause: value.cause };
    case 'STALE_WRITE': {
      const conflictKey = optString(value.conflictKey);
      if (conflictKey === null) return null;
      return conflictKey === undefined
        ? { ok: false, code: 'STALE_WRITE', error }
        : { ok: false, code: 'STALE_WRITE', error, conflictKey };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Frame decoders
// ---------------------------------------------------------------------------

function fail<F>(reason: string): Decoded<F> {
  return { ok: false, reason };
}

/** Byte check first, then JSON.parse; returns the envelope record or a reason. */
function parseEnvelope(
  text: string,
): { ok: true; rec: Record<string, unknown> } | { ok: false; reason: string } {
  if (Buffer.byteLength(text) > NODE_FRAME_MAX_BYTES)
    return { ok: false, reason: 'frame too large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'frame is not an object' };
  if (parsed.v !== NODE_PROTOCOL_VERSION)
    return { ok: false, reason: 'unsupported protocol version' };
  if (!isString(parsed.kind)) return { ok: false, reason: 'missing kind' };
  return { ok: true, rec: parsed };
}

function decodePing(
  rec: Record<string, unknown>,
  kind: 'ping' | 'pong',
): Decoded<PingFrame | PongFrame> {
  if (!isNumber(rec.at)) return fail('bad ping');
  return { ok: true, frame: { v: 1, kind, at: rec.at } };
}

export function decodeNodeFrame(text: string): Decoded<NodeToServerFrame> {
  const env = parseEnvelope(text);
  if (!env.ok) return fail(env.reason);
  const rec = env.rec;
  switch (rec.kind) {
    case 'hello': {
      const roots = decodeRoots(rec.roots);
      if (
        !isString(rec.name) ||
        roots === null ||
        !isStringArray(rec.tools) ||
        !isStringArray(rec.personalities) ||
        !isNumber(rec.clock)
      ) {
        return fail('bad hello');
      }
      return {
        ok: true,
        frame: {
          v: 1,
          kind: 'hello',
          name: rec.name,
          roots,
          tools: [...rec.tools],
          personalities: [...rec.personalities],
          clock: rec.clock,
        },
      };
    }
    case 'progress': {
      if (!isString(rec.callId) || !isString(rec.message)) return fail('bad progress');
      const frame: ProgressFrame = {
        v: 1,
        kind: 'progress',
        callId: rec.callId,
        message: rec.message,
      };
      if (rec.audience !== undefined) {
        if (
          rec.audience !== 'internal' &&
          rec.audience !== 'user' &&
          rec.audience !== 'dashboard'
        ) {
          return fail('bad progress audience');
        }
        frame.audience = rec.audience;
      }
      return { ok: true, frame };
    }
    case 'result': {
      if (!isString(rec.callId)) return fail('bad result');
      const result = decodeToolResult(rec.result);
      if (result === null) return fail('bad result payload');
      return { ok: true, frame: { v: 1, kind: 'result', callId: rec.callId, result } };
    }
    case 'ping':
    case 'pong':
      return decodePing(rec, rec.kind);
    default:
      return fail('unknown frame kind');
  }
}

export function decodeServerFrame(text: string): Decoded<ServerToNodeFrame> {
  const env = parseEnvelope(text);
  if (!env.ok) return fail(env.reason);
  const rec = env.rec;
  switch (rec.kind) {
    case 'call': {
      if (!isCallId(rec.callId) || !isNumber(rec.deadline)) return fail('bad call');
      const request = decodeToolExecuteRequest(rec.request);
      if (request === null) return fail('bad call request');
      return {
        ok: true,
        frame: { v: 1, kind: 'call', callId: rec.callId, deadline: rec.deadline, request },
      };
    }
    case 'cancel':
      if (!isCallId(rec.callId)) return fail('bad cancel');
      return { ok: true, frame: { v: 1, kind: 'cancel', callId: rec.callId } };
    case 'ping':
    case 'pong':
      return decodePing(rec, rec.kind);
    default:
      return fail('unknown frame kind');
  }
}

export function decodePairClientFrame(text: string): Decoded<PairClientFrame> {
  const env = parseEnvelope(text);
  if (!env.ok) return fail(env.reason);
  const rec = env.rec;
  if (rec.kind !== 'pair_request') return fail('unknown frame kind');
  const roots = decodeRoots(rec.roots);
  if (!isString(rec.name) || roots === null) return fail('bad pair_request');
  return { ok: true, frame: { v: 1, kind: 'pair_request', name: rec.name, roots } };
}

export function decodePairServerFrame(text: string): Decoded<PairServerFrame> {
  const env = parseEnvelope(text);
  if (!env.ok) return fail(env.reason);
  const rec = env.rec;
  switch (rec.kind) {
    case 'pair_pending':
      if (!isString(rec.code) || !isNumber(rec.expiresAt)) return fail('bad pair_pending');
      return {
        ok: true,
        frame: { v: 1, kind: 'pair_pending', code: rec.code, expiresAt: rec.expiresAt },
      };
    case 'pair_approved':
      if (!isString(rec.key) || !isString(rec.keyId)) return fail('bad pair_approved');
      return { ok: true, frame: { v: 1, kind: 'pair_approved', key: rec.key, keyId: rec.keyId } };
    case 'pair_refused':
      if (!isString(rec.reason)) return fail('bad pair_refused');
      return { ok: true, frame: { v: 1, kind: 'pair_refused', reason: rec.reason } };
    default:
      return fail('unknown frame kind');
  }
}
