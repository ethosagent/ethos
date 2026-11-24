/**
 * NodeClient — the laptop's outbound socket to an Ethos server (plan §3.3, D11, D15).
 *
 * Every `call` frame goes through `NodeGuard.admit` before `execute`; a refusal is sent back as the
 * result and execute never runs (pinned by __tests__/node-client.test.ts). `sendResult` is the
 * enforcer of the node-side output cap (plan §4 Output row).
 */
import type { Logger, ToolExecuteRequest, ToolProgressEvent, ToolResult } from '@ethosagent/types';
import { capNodeResult, capProgress } from './caps';
import {
  type AnyNodeFrame,
  decodePairServerFrame,
  decodeServerFrame,
  encodeFrame,
  type HelloFrame,
  NODE_CLOSE,
  NODE_FRAME_MAX_BYTES,
  NODE_PAIR_PATH,
  NODE_SOCKET_PATH,
  type NodeRootAdvert,
  type ServerToNodeFrame,
} from './frames';
import type { NodeGuard } from './node-guard';
import {
  createWsNodeSocket,
  type NodeSocket,
  type NodeSocketFactory,
  type NodeSocketHandlers,
} from './node-socket-transport';
import { assertSecureNodeUrl, nextBackoffMs } from './node-url';

export type NodeClientStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unauthorized'
  | 'replaced'
  | 'stopped';

export interface NodeClientOptions {
  url: string;
  key: string;
  hello: Omit<HelloFrame, 'v' | 'kind' | 'clock'>;
  guard: NodeGuard;
  execute: (
    request: ToolExecuteRequest,
    signal: AbortSignal,
    emit: (e: ToolProgressEvent) => void,
  ) => Promise<ToolResult>;
  socketFactory?: NodeSocketFactory;
  now?: () => number;
  /** `retryInMs` is set on 'disconnected': the jittered delay before the next attempt. */
  onStatus?: (status: NodeClientStatus, detail?: string, retryInMs?: number) => void;
  logger?: Logger;
  /** Backoff jitter source; default `Math.random`. */
  random?: () => number;
}

const UNAUTHORIZED_DETAIL =
  'the server rejected this node key (revoked or unknown): re-pair with `ethos node connect`';

export class NodeClient {
  private readonly url: string;
  private readonly factory: NodeSocketFactory;
  private readonly now: () => number;
  private socket: NodeSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;
  private current: NodeClientStatus = 'disconnected';
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly opts: NodeClientOptions) {
    this.url = assertSecureNodeUrl(opts.url, NODE_SOCKET_PATH).href;
    this.factory = opts.socketFactory ?? createWsNodeSocket;
    this.now = opts.now ?? Date.now;
  }

  get status(): NodeClientStatus {
    return this.current;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortAll();
    this.socket?.close(NODE_CLOSE.normal, 'stopping');
    this.setStatus('stopped');
  }

  private setStatus(s: NodeClientStatus, detail?: string, retryInMs?: number): void {
    this.current = s;
    this.opts.onStatus?.(s, detail, retryInMs);
  }

  private abortAll(): void {
    for (const c of this.running.values()) c.abort();
    this.running.clear();
  }

  private connect(): void {
    this.setStatus('connecting');
    let done = false; // each socket's close is handled once
    const handlers: NodeSocketHandlers = {
      onOpen: () => {
        this.attempt = 0;
        this.opts.guard.newConnection();
        this.send({ v: 1, kind: 'hello', ...this.opts.hello, clock: this.now() });
        this.setStatus('connected');
      },
      onText: (text) => this.onText(text),
      onError: (err) => this.opts.logger?.warn('node socket error', { error: err.message }),
      onUnexpectedResponse: (status) => {
        if (status === 401) this.setStatus('unauthorized', UNAUTHORIZED_DETAIL);
        else this.opts.logger?.warn('node upgrade refused', { status });
      },
      onClose: (code, reason) => {
        if (done) return;
        done = true;
        this.abortAll();
        if (this.stopped) return;
        // 4401 (key revoked while connected) is the live-socket twin of the 401 on upgrade.
        if (code === NODE_CLOSE.revoked) this.setStatus('unauthorized', UNAUTHORIZED_DETAIL);
        else if (code === NODE_CLOSE.replaced) {
          this.setStatus(
            'replaced',
            'replaced by another connection using this key — if that was not you, run `ethos node revoke <name>` on the server',
          );
        }
        // Neither a revoked key nor a replaced node reconnects: retrying would only fight.
        if (this.current === 'unauthorized' || this.current === 'replaced') return;
        const delay = nextBackoffMs(this.attempt, this.opts.random);
        this.attempt += 1;
        this.setStatus('disconnected', reason || undefined, delay);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (!this.stopped) this.connect();
        }, delay);
      },
    };
    this.socket = this.factory(
      this.url,
      {
        headers: { Authorization: `Bearer ${this.opts.key}` },
        maxPayload: NODE_FRAME_MAX_BYTES,
      },
      handlers,
    );
  }

  private send(frame: AnyNodeFrame): void {
    try {
      this.socket?.send(encodeFrame(frame));
    } catch (err) {
      this.opts.logger?.warn('node send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onText(text: string): void {
    const decoded = decodeServerFrame(text);
    if (!decoded.ok) {
      this.opts.logger?.warn('bad frame from server', { reason: decoded.reason });
      this.socket?.close(NODE_CLOSE.badFrame, decoded.reason);
      return;
    }
    const frame: ServerToNodeFrame = decoded.frame;
    switch (frame.kind) {
      case 'ping':
        this.send({ v: 1, kind: 'pong', at: frame.at });
        return;
      case 'cancel':
        this.running.get(frame.callId)?.abort();
        return;
      case 'call':
        void this.handleCall(frame);
        return;
      default:
        return;
    }
  }

  private async handleCall(frame: Extract<ServerToNodeFrame, { kind: 'call' }>): Promise<void> {
    const { callId } = frame;
    const budget = frame.request.resultBudgetChars;
    // A repeated id must not replace the running call's AbortController (cancel would miss it).
    if (this.running.has(callId)) {
      return this.sendResult(
        callId,
        { ok: false, code: 'not_available', error: 'duplicate callId refused by the node' },
        budget,
      );
    }
    const ac = new AbortController();
    this.running.set(callId, ac);
    try {
      const admission = await this.opts.guard.admit(frame, ac.signal);
      if (!admission.ok) return this.sendResult(callId, admission.result, budget);
      if (ac.signal.aborted) {
        return this.sendResult(
          callId,
          { ok: false, code: 'execution_failed', error: 'aborted' },
          budget,
        );
      }
      const result = await this.opts.execute(admission.request, ac.signal, (e) =>
        this.send({
          v: 1,
          kind: 'progress',
          callId,
          message: capProgress(e.message),
          ...(e.audience && { audience: e.audience }),
        }),
      );
      this.sendResult(callId, result, budget);
    } catch (err) {
      this.sendResult(
        callId,
        {
          ok: false,
          code: 'execution_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        budget,
      );
    } finally {
      this.running.delete(callId);
    }
  }

  /** The node-side output cap (plan §4 Output row): `min(request budget, 64 KiB)`. */
  private sendResult(callId: string, result: ToolResult, budgetChars: number): void {
    this.send({ v: 1, kind: 'result', callId, result: capNodeResult(result, budgetChars) });
  }
}

/** One-shot pairing over `/node/pair` (no auth header): resolves the minted key on approval. */
export function pairNode(opts: {
  url: string;
  name: string;
  roots: NodeRootAdvert[];
  socketFactory?: NodeSocketFactory;
  onCode: (code: string, expiresAt: number) => void;
}): Promise<{ key: string; keyId: string }> {
  const url = assertSecureNodeUrl(opts.url, NODE_PAIR_PATH).href;
  const factory = opts.socketFactory ?? createWsNodeSocket;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const socket = factory(
      url,
      { maxPayload: NODE_FRAME_MAX_BYTES },
      {
        onOpen: () =>
          socket.send(
            encodeFrame({ v: 1, kind: 'pair_request', name: opts.name, roots: opts.roots }),
          ),
        onText: (text) => {
          const d = decodePairServerFrame(text);
          if (!d.ok) {
            finish(() => reject(new Error(`bad frame from server: ${d.reason}`)));
            socket.close(NODE_CLOSE.badFrame, d.reason);
            return;
          }
          const f = d.frame;
          if (f.kind === 'pair_pending') opts.onCode(f.code, f.expiresAt);
          else if (f.kind === 'pair_approved') {
            finish(() => resolve({ key: f.key, keyId: f.keyId }));
            socket.close(NODE_CLOSE.normal, 'paired');
          } else {
            finish(() => reject(new Error(`pairing refused: ${f.reason}`)));
            socket.close(NODE_CLOSE.normal, 'refused');
          }
        },
        onClose: () => finish(() => reject(new Error('connection closed before pairing finished'))),
        onError: (err) => finish(() => reject(err)),
        onUnexpectedResponse: (status) =>
          finish(() => reject(new Error(`server refused the pairing connection (HTTP ${status})`))),
      },
    );
  });
}
