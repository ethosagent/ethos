import type { ToolCapabilities, ToolExecuteRequest, ToolResult } from '@ethosagent/types';
import { isRecord } from './util';

/**
 * Plugin-host wire protocol: JSON-RPC 2.0, one JSON object per line (NDJSON) on
 * the child's stdin/stdout (plan plugin-process-isolation §5.2, §5.3, D5).
 * Parent -> host methods are driven by the pool; host -> parent methods are
 * answered by the handler table in `HostConnection`.
 */

export const PROTOCOL_VERSION = 1;

/** D11. A larger frame, or a line that grows past this with no newline, is a protocol violation. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type RpcId = number;

export interface RpcRequest {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId;
  result?: unknown;
  error?: RpcErrorBody;
  /** Additive: milliseconds the responder spent in the handler (observability only). */
  hostMs?: number;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** JSON-RPC 2.0 reserved codes plus the two this protocol adds. */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  handlerFailed: -32000,
  cancelled: -32001,
  /** The request was refused by an authorisation check (revoked handle, denied secret ref). */
  denied: -32002,
} as const;

// ---------------------------------------------------------------------------
// Registrations: what a hosted plugin's activate() registered, as plain data.
// ---------------------------------------------------------------------------

export interface ToolRegistration {
  kind: 'tool';
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  capabilities: ToolCapabilities;
  /** `isAvailable()` as answered at activation; refreshed by the ping. */
  available: boolean;
  requiresApproval?: boolean;
  returnDirect?: boolean;
  outputSchema?: Record<string, unknown>;
  preferredModel?: string;
  strict?: boolean;
  settingsKey?: string;
}

export interface HookRegistration {
  kind: 'hook';
  model: 'void' | 'modifying';
  name: string;
}

/** A context injector; `shouldInject` runs host-side, so only id and priority cross. */
export interface InjectorRegistration {
  kind: 'injector';
  index: number;
  id: string;
  priority: number;
}

export interface FilterRegistration {
  kind: 'filter';
  index: number;
  toolName?: string | string[];
  toolset?: string;
  before: boolean;
  after: boolean;
}

export interface EvaluatorRegistration {
  kind: 'evaluator';
  index: number;
  name: string;
}

export interface RouteRegistration {
  kind: 'route';
  index: number;
  method: string;
  path: string;
}

export interface HealthCheckRegistration {
  kind: 'health_check';
  index: number;
  name: string;
  description: string;
}

export interface SlashRegistration {
  kind: 'slash';
  name: string;
  description: string;
  usage: string;
}

export interface CliRegistration {
  kind: 'cli';
  name: string;
  description: string;
}

export interface ExtractorRegistration {
  kind: 'extractor';
  index: number;
  name: string;
  mimeTypes: string[];
  maxInputBytes?: number;
}

export interface DataSourceRegistration {
  kind: 'data_source';
  id: string;
  path: string;
}

/** Plain-data registrations replayed verbatim; the payload is validated again in the parent. */
export interface DataRegistration {
  kind: 'personality' | 'oauth_profile' | 'page' | 'renderer';
  data: Record<string, unknown>;
}

export type Registration =
  | ToolRegistration
  | HookRegistration
  | InjectorRegistration
  | FilterRegistration
  | EvaluatorRegistration
  | RouteRegistration
  | HealthCheckRegistration
  | SlashRegistration
  | CliRegistration
  | ExtractorRegistration
  | DataSourceRegistration
  | DataRegistration;

// ---------------------------------------------------------------------------
// Parent -> host
// ---------------------------------------------------------------------------

export interface ActivateParams {
  pluginId: string;
  dir: string;
  entry?: string;
  tier?: string;
  dataDir: string;
  hostHome: string;
  baseUrl?: string;
  /** Key NAMES only (D19). Values cross per call, never at spawn. */
  secretKeys: string[];
  protocolVersion: number;
}

export interface ActivateResult {
  registrations: Registration[];
  /** True when the plugin holds monitors, routes or bus subscriptions (eager restart, D15). */
  holdsLongLived: boolean;
  /** Additive: the child's resident set size in MB right after activation. */
  rssMb?: number;
}

/** Handle for the reverse capability calls of one in-flight call (§5.6). */
export type CallHandle = string;

/**
 * What the parent's live `ToolContext` had at call time, so the child exposes
 * exactly the handles a non-hosted tool would see (plan §5.6).
 */
export interface LiveSnapshot {
  llm: boolean;
  context: boolean;
  /** `attachments.list()` is synchronous, so it crosses as a snapshot. */
  attachments?: unknown[];
}

export interface ToolExecuteParams {
  name: string;
  request: ToolExecuteRequest;
  call: CallHandle;
  live?: LiveSnapshot;
}

export interface HookFireParams {
  model: 'void' | 'modifying';
  name: string;
  payload: unknown;
}

export interface PingResult {
  /** Tool name -> `isAvailable()` right now. */
  tools: Record<string, boolean>;
  /** Additive: the child's resident set size in MB (`process.memoryUsage().rss`). */
  rssMb?: number;
}

/** Method name -> params/result. `result: never` marks a notification. */
export interface ParentToHostMethods {
  'ethos/activate': { params: ActivateParams; result: ActivateResult };
  'ethos/tool.execute': { params: ToolExecuteParams; result: ToolResult };
  'ethos/hook.fire': { params: HookFireParams; result: unknown };
  'ethos/injector.inject': {
    params: { index: number; label: string; ctx: unknown };
    result: unknown;
  };
  'ethos/filter.before': {
    params: {
      index: number;
      call: CallHandle;
      args: unknown;
      meta: unknown;
      request: unknown;
      live?: LiveSnapshot;
    };
    result: unknown;
  };
  'ethos/filter.after': {
    params: {
      index: number;
      call: CallHandle;
      result: unknown;
      meta: unknown;
      request: unknown;
      live?: LiveSnapshot;
    };
    result: unknown;
  };
  'ethos/evaluator.evaluate': {
    params: { index: number; call: CallHandle; payload: unknown };
    result: unknown;
  };
  'ethos/route.handle': { params: { index: number; req: unknown }; result: unknown };
  'ethos/command.run': {
    params: { kind: 'slash' | 'cli'; name: string; call: CallHandle; input: unknown };
    result: unknown;
  };
  'ethos/health.run': { params: { index: number }; result: unknown };
  'ethos/extract': { params: { index: number; bytes: unknown; mime: string }; result: unknown };
  'ethos/event': { params: { type: 'bus'; event: string; payload: unknown }; result: never };
  'ethos/cancel': { params: { id: RpcId }; result: never };
  'ethos/ping': { params: Record<string, never>; result: PingResult };
  'ethos/shutdown': { params: Record<string, never>; result: null };
}

// ---------------------------------------------------------------------------
// Host -> parent
// ---------------------------------------------------------------------------

export interface HostToParentMethods {
  'ethos/ready': { params: { protocolVersion: number; pid: number }; result: never };
  'ethos/secrets.get': { params: { ref: string }; result: string | null };
  'ethos/secrets.set': { params: { ref: string; value: string }; result: null };
  'ethos/secrets.list': { params: { prefix?: string }; result: string[] };
  'ethos/capability.storage': {
    params: { call: CallHandle; op: string; args: unknown[] };
    result: unknown;
  };
  'ethos/capability.kv': {
    params: { call: CallHandle; op: string; args: unknown[] };
    result: unknown;
  };
  'ethos/capability.secret': {
    params: { call: CallHandle; op: string; args: unknown[] };
    result: unknown;
  };
  'ethos/capability.fetch': { params: { call: CallHandle; args: unknown[] }; result: unknown };
  'ethos/capability.fs': {
    params: { call: CallHandle; op: string; args: unknown[] };
    result: unknown;
  };
  'ethos/capability.attachments': {
    params: { call: CallHandle; op: string; args: unknown[] };
    result: unknown;
  };
  'ethos/capability.llm': { params: { call: CallHandle; args: unknown[] }; result: unknown };
  'ethos/capability.context': {
    params: { call: CallHandle; op: string; args: unknown[] };
    result: unknown;
  };
  'ethos/emit': {
    params: { call: CallHandle; event: unknown };
    result: never;
  };
  'ethos/notify': { params: { opts: unknown }; result: null };
  'ethos/diagnostics': {
    params:
      | { kind: 'event'; level: string; message: string; data?: unknown }
      | { kind: 'metric'; name: string; value: number; labels?: unknown };
    result: never;
  };
  'ethos/bus.emit': { params: { event: string; payload: unknown }; result: never };
  'ethos/bus.subscribe': { params: { event: string }; result: never };
  /** A bus payload the host could not serialise and so dropped (counted in the parent). */
  'ethos/bus.dropped': { params: { event: string }; result: never };
  /** `MonitorRunContext.llm`: a monitor has no call, so it is served by the parent's llm factory. */
  'ethos/monitor.llm': { params: { prompt: string; options?: unknown }; result: string };
  /** `send`/`stdout`/`stderr`/`emit` of a slash, CLI or command call. */
  'ethos/command.output': {
    params: { call: CallHandle; stream: 'send' | 'stdout' | 'stderr' | 'emit'; text: string };
    result: never;
  };
  /** The host now holds monitors, routes or bus subscriptions (eager restart, D15). */
  'ethos/long-lived': { params: { value: boolean }; result: never };
  'ethos/registration.added': { params: { registration: Registration }; result: never };
  'ethos/log': {
    params: { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
    result: never;
  };
}

export type ParentToHostMethod = keyof ParentToHostMethods;
export type HostToParentMethod = keyof HostToParentMethods;

/**
 * Every method and whether it is a request or a notification. Typed as full
 * records so a method added to either table fails typecheck until classified.
 */
export const PARENT_TO_HOST_KIND: Record<ParentToHostMethod, 'request' | 'notification'> = {
  'ethos/activate': 'request',
  'ethos/tool.execute': 'request',
  'ethos/hook.fire': 'request',
  'ethos/injector.inject': 'request',
  'ethos/filter.before': 'request',
  'ethos/filter.after': 'request',
  'ethos/evaluator.evaluate': 'request',
  'ethos/route.handle': 'request',
  'ethos/command.run': 'request',
  'ethos/health.run': 'request',
  'ethos/extract': 'request',
  'ethos/event': 'notification',
  'ethos/cancel': 'notification',
  'ethos/ping': 'request',
  'ethos/shutdown': 'request',
};

export const HOST_TO_PARENT_KIND: Record<HostToParentMethod, 'request' | 'notification'> = {
  'ethos/ready': 'notification',
  'ethos/secrets.get': 'request',
  'ethos/secrets.set': 'request',
  'ethos/secrets.list': 'request',
  'ethos/capability.storage': 'request',
  'ethos/capability.kv': 'request',
  'ethos/capability.secret': 'request',
  'ethos/capability.fetch': 'request',
  'ethos/capability.fs': 'request',
  'ethos/capability.attachments': 'request',
  'ethos/capability.llm': 'request',
  'ethos/capability.context': 'request',
  'ethos/emit': 'notification',
  'ethos/notify': 'request',
  'ethos/diagnostics': 'notification',
  'ethos/bus.emit': 'notification',
  'ethos/bus.subscribe': 'notification',
  'ethos/bus.dropped': 'notification',
  'ethos/monitor.llm': 'request',
  'ethos/command.output': 'notification',
  'ethos/long-lived': 'notification',
  'ethos/registration.added': 'notification',
  'ethos/log': 'notification',
};

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export class ProtocolViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolViolation';
  }
}

const NEWLINE = 0x0a;

/** Validates the JSON-RPC envelope. Throws ProtocolViolation on anything else. */
function hostMsOf(raw: Record<string, unknown>): { hostMs?: number } {
  return typeof raw.hostMs === 'number' && Number.isFinite(raw.hostMs)
    ? { hostMs: raw.hostMs }
    : {};
}

export function parseMessage(line: string): RpcMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolViolation('malformed JSON line');
  }
  if (!isRecord(raw) || raw.jsonrpc !== '2.0') {
    throw new ProtocolViolation('not a JSON-RPC 2.0 message');
  }
  const { id, method } = raw;
  const hasId = id !== undefined;
  if (hasId && (typeof id !== 'number' || !Number.isSafeInteger(id))) {
    throw new ProtocolViolation('message id is not an integer');
  }
  if (typeof method === 'string') {
    return hasId
      ? { jsonrpc: '2.0', id: id as RpcId, method, params: raw.params }
      : { jsonrpc: '2.0', method, params: raw.params };
  }
  if (!hasId) throw new ProtocolViolation('message has neither method nor id');
  if ('error' in raw) {
    const err = raw.error;
    if (!isRecord(err) || typeof err.code !== 'number' || typeof err.message !== 'string') {
      throw new ProtocolViolation('malformed error response');
    }
    return {
      jsonrpc: '2.0',
      id: id as RpcId,
      error: { code: err.code, message: err.message, data: err.data },
      ...hostMsOf(raw),
    };
  }
  if (!('result' in raw)) throw new ProtocolViolation('response has neither result nor error');
  return { jsonrpc: '2.0', id: id as RpcId, result: raw.result, ...hostMsOf(raw) };
}

/**
 * Newline-delimited JSON codec with a frame limit. `push` is fed raw stream
 * chunks and returns every complete message; a malformed line or a frame over
 * the limit throws `ProtocolViolation` (the owner kills the host).
 */
export class LineCodec {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  static encode(message: RpcMessage, maxFrameBytes: number = MAX_FRAME_BYTES): string {
    return LineCodec.encodeFramed(message, maxFrameBytes).line;
  }

  /** `encode` plus the frame's size in bytes (newline included), so callers need not re-measure. */
  static encodeFramed(
    message: RpcMessage,
    maxFrameBytes: number = MAX_FRAME_BYTES,
  ): { line: string; bytes: number } {
    const line = JSON.stringify(message);
    const bytes = Buffer.byteLength(line);
    if (bytes > maxFrameBytes) {
      throw new ProtocolViolation(`frame exceeds ${maxFrameBytes} bytes`);
    }
    return { line: `${line}\n`, bytes: bytes + 1 };
  }

  push(chunk: Buffer | string): RpcMessage[] {
    return this.pushFramed(chunk).map((f) => f.message);
  }

  /** `push` plus each message's line length in bytes (newline excluded). */
  pushFramed(chunk: Buffer | string): Array<{ message: RpcMessage; bytes: number }> {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const out: Array<{ message: RpcMessage; bytes: number }> = [];
    for (;;) {
      const nl = buf.indexOf(NEWLINE);
      if (nl === -1) {
        this.pending.push(buf);
        this.pendingBytes += buf.length;
        if (this.pendingBytes > this.maxFrameBytes) {
          this.pending = [];
          this.pendingBytes = 0;
          throw new ProtocolViolation(`frame exceeds ${this.maxFrameBytes} bytes`);
        }
        return out;
      }
      const head = buf.subarray(0, nl);
      const line = Buffer.concat([...this.pending, head]);
      this.pending = [];
      this.pendingBytes = 0;
      buf = buf.subarray(nl + 1);
      if (line.length > this.maxFrameBytes) {
        throw new ProtocolViolation(`frame exceeds ${this.maxFrameBytes} bytes`);
      }
      const text = line.toString('utf8').trim();
      if (text !== '') out.push({ message: parseMessage(text), bytes: line.length });
    }
  }
}
