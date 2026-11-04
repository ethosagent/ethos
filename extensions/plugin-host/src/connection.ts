import {
  LineCodec,
  MAX_FRAME_BYTES,
  ProtocolViolation,
  RPC_ERROR,
  type RpcId,
  type RpcMessage,
  type RpcResponse,
} from './protocol';

export interface IncomingContext {
  /** The id the peer issued, absent for notifications. */
  id?: RpcId;
}

export type IncomingHandler = (params: unknown, ctx: IncomingContext) => Promise<unknown> | unknown;

/** Method name -> handler for requests (and notifications) the peer sends us. */
export type HandlerTable = Record<string, IncomingHandler>;

/** The peer answered with a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`'${method}' timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** The connection closed (the host exited) with this request still pending. */
export class ConnectionClosedError extends Error {
  constructor(
    message: string,
    readonly exit?: { code: number | null; signal: string | null },
  ) {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Called synchronously with the issued id (so a caller can `ethos/cancel` it). */
  onId?: (id: RpcId) => void;
  /** Observability: called once when the response arrives, never for a timeout or a closed pipe. */
  onMeta?: (meta: RequestMeta) => void;
}

export interface RequestMeta {
  reqBytes: number;
  resBytes: number;
  /** Time the peer reported spending in its handler. */
  hostMs?: number;
}

export interface ConnectionOptions {
  /** Writes one already-framed line to the peer. */
  write: (line: string) => void;
  handlers: HandlerTable;
  /** A malformed line or an oversize frame: the owner kills the host. */
  onViolation: (reason: string) => void;
  onNotification?: (method: string, params: unknown) => void;
  maxFrameBytes?: number;
}

export interface ConnectionStats {
  strayResponses: number;
  duplicateResponses: number;
  violations: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  onMeta?: (meta: RequestMeta) => void;
  reqBytes: number;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One end of a plugin-host pipe. Rules (plan §5.3):
 * - ids are issued per connection (so per host); a response for an id never
 *   issued, or one already settled, is dropped and counted;
 * - a malformed line or oversize frame is a protocol violation, reported once
 *   through `onViolation`; nothing further is parsed afterwards;
 * - an incoming request for a method with no handler answers a JSON-RPC
 *   method-not-found error.
 */
export class HostConnection {
  readonly stats: ConnectionStats = { strayResponses: 0, duplicateResponses: 0, violations: 0 };

  private readonly codec: LineCodec;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly maxFrameBytes: number;
  private lastId = 0;
  private closed: ConnectionClosedError | null = null;
  private violated = false;

  constructor(private readonly opts: ConnectionOptions) {
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.codec = new LineCodec(this.maxFrameBytes);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Feed a raw chunk from the peer's output stream. */
  feed(chunk: Buffer | string): void {
    if (this.violated || this.closed) return;
    let messages: RpcMessage[];
    try {
      messages = this.codec.push(chunk);
    } catch (err) {
      this.violate(err instanceof Error ? err.message : String(err));
      return;
    }
    for (const msg of messages) {
      if (this.violated) return;
      this.dispatch(msg);
    }
  }

  request<T = unknown>(method: string, params: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.lastId;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        method,
        resolve: (v) => resolve(v as T),
        reject,
        reqBytes: 0,
        ...(opts.onMeta ? { onMeta: opts.onMeta } : {}),
      };
      if (opts.timeoutMs !== undefined) {
        const ms = opts.timeoutMs;
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new RequestTimeoutError(method, ms));
        }, ms);
      }
      this.pending.set(id, entry);
      opts.onId?.(id);
      try {
        entry.reqBytes = this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.settle(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.send({ jsonrpc: '2.0', method, params });
    } catch {
      // An unframeable notification (oversize) is dropped; requests surface it.
    }
  }

  /** Rejects every pending request and ignores further input. Idempotent. */
  close(err: ConnectionClosedError): void {
    if (this.closed) return;
    this.closed = err;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
  }

  /** Returns the framed size in bytes. */
  private send(msg: RpcMessage): number {
    const line = LineCodec.encode(msg, this.maxFrameBytes);
    this.opts.write(line);
    return Buffer.byteLength(line);
  }

  private settle(id: RpcId): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }

  private violate(reason: string): void {
    if (this.violated) return;
    this.violated = true;
    this.stats.violations++;
    this.opts.onViolation(reason);
  }

  private dispatch(msg: RpcMessage): void {
    if ('method' in msg) {
      void this.handleIncoming(msg.method, msg.params, 'id' in msg ? msg.id : undefined);
      return;
    }
    this.handleResponse(msg);
  }

  private handleResponse(msg: RpcResponse): void {
    const entry = this.settle(msg.id);
    if (!entry) {
      // Ids are monotonic: an id we issued and no longer track was already
      // settled (duplicate, or late after a timeout); anything else was never ours.
      if (msg.id >= 1 && msg.id <= this.lastId) this.stats.duplicateResponses++;
      else this.stats.strayResponses++;
      return;
    }
    if (msg.error) {
      entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      if (entry.onMeta) {
        try {
          entry.onMeta({
            reqBytes: entry.reqBytes,
            resBytes: Buffer.byteLength(JSON.stringify(msg.result ?? null)),
            ...(msg.hostMs !== undefined ? { hostMs: msg.hostMs } : {}),
          });
        } catch {
          // observability only
        }
      }
      entry.resolve(msg.result);
    }
  }

  private async handleIncoming(
    method: string,
    params: unknown,
    id: RpcId | undefined,
  ): Promise<void> {
    if (id === undefined) {
      this.opts.onNotification?.(method, params);
      const handler = this.opts.handlers[method];
      if (handler) {
        try {
          await handler(params, {});
        } catch {
          // A notification has no response channel; the handler owns its own reporting.
        }
      }
      return;
    }
    const handler = this.opts.handlers[method];
    if (!handler) {
      this.reply({
        jsonrpc: '2.0',
        id,
        error: { code: RPC_ERROR.methodNotFound, message: `Method not found: ${method}` },
      });
      return;
    }
    const t0 = performance.now();
    try {
      const result = await handler(params, { id });
      this.reply({
        jsonrpc: '2.0',
        id,
        result: result === undefined ? null : result,
        hostMs: performance.now() - t0,
      });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : RPC_ERROR.handlerFailed;
      const message = err instanceof Error ? err.message : String(err);
      const data = err instanceof RpcError ? err.data : undefined;
      this.reply({
        jsonrpc: '2.0',
        id,
        error: { code, message, data },
        hostMs: performance.now() - t0,
      });
    }
  }

  private reply(msg: RpcResponse): void {
    if (this.closed) return;
    try {
      this.send(msg);
    } catch (err) {
      if (err instanceof ProtocolViolation) {
        // The answer itself is too big: tell the peer instead of dropping it.
        try {
          this.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: RPC_ERROR.internal, message: err.message },
          });
        } catch {
          // The pipe is gone; the owner sees the exit.
        }
      }
    }
  }
}
