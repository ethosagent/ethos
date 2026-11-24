/**
 * NodeHub — the server's in-memory registry of connected laptop nodes (plan D6, D11, D16).
 *
 * A node is identified by its API-key id, never its name. The hub never parses text: the web-api
 * socket decodes frames and hands them to `NodeSession.receive`.
 *
 * Guarantees, each pinned by extensions/execution-node/src/__tests__/node-transport.test.ts:
 *  - a call is never retried: a drop resolves it `node_disconnected` and sends no second frame;
 *  - the newer connection wins: `attach` for a live keyId closes the old one with 4000.
 */
import type { Logger, ToolExecuteRequest, ToolResult } from '@ethosagent/types';
import {
  type HelloFrame,
  NODE_CLOSE,
  NODE_DISCONNECTED,
  type NodeRootAdvert,
  type NodeToServerFrame,
  type ServerToNodeFrame,
} from './frames';

/** Grace added to a call's tool timeout before the node's deadline / the server's give-up (D15). */
const DEADLINE_GRACE_MS = 5000;

export interface NodeConnection {
  send(frame: ServerToNodeFrame): void;
  close(code: number, reason: string): void;
}
export interface NodeListEntry {
  name: string;
  keyId: string;
  online: boolean;
  roots: NodeRootAdvert[];
  tools: string[];
  personalities: string[];
  connectedAt?: string;
  lastSeen: string;
  replacedAt?: string;
}
export interface NodeCallOptions {
  signal: AbortSignal;
  timeoutMs: number;
  onProgress?: (message: string) => void;
}
export interface NodeSession {
  readonly keyId: string;
  readonly name: string;
  receive(frame: NodeToServerFrame): void;
  detach(): void;
  call(request: ToolExecuteRequest, opts: NodeCallOptions): Promise<ToolResult>;
}
export type NodePick = { ok: true; session: NodeSession } | { ok: false; result: ToolResult };

interface Entry {
  keyId: string;
  name: string;
  roots: NodeRootAdvert[];
  tools: string[];
  personalities: string[];
  connectedAt?: number;
  lastSeen: number;
  replacedAt?: number;
  session?: SessionImpl;
}

interface Pending {
  resolve: (r: ToolResult) => void;
  onProgress?: (message: string) => void;
  cleanup: () => void;
}

const failed = (error: string): ToolResult => ({ ok: false, code: 'execution_failed', error });

class SessionImpl implements NodeSession {
  private readonly pending = new Map<string, Pending>();
  private attached = true;

  constructor(
    readonly keyId: string,
    readonly name: string,
    private readonly conn: NodeConnection,
    private readonly skew: number,
    private readonly now: () => number,
    private readonly randomId: () => string,
    private readonly onDetach: (s: SessionImpl) => void,
  ) {}

  get isAttached(): boolean {
    return this.attached;
  }

  receive(frame: NodeToServerFrame): void {
    switch (frame.kind) {
      case 'result': {
        const p = this.pending.get(frame.callId);
        if (!p) return; // unknown callId: ignored (node-transport.test.ts)
        p.cleanup();
        p.resolve(frame.result);
        return;
      }
      case 'progress':
        this.pending.get(frame.callId)?.onProgress?.(frame.message);
        return;
      case 'ping':
        this.safeSend({ v: 1, kind: 'pong', at: frame.at });
        return;
      default:
        return;
    }
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const p of [...this.pending.values()]) {
      p.cleanup();
      p.resolve(
        failed(
          `${NODE_DISCONNECTED}: node '${this.name}' disconnected mid-call; the call was not retried and may have partly run`,
        ),
      );
    }
    this.onDetach(this);
  }

  call(request: ToolExecuteRequest, opts: NodeCallOptions): Promise<ToolResult> {
    if (opts.signal.aborted) return Promise.resolve(failed('aborted'));
    if (!this.attached) {
      return Promise.resolve(failed(`${NODE_DISCONNECTED}: node '${this.name}' is not connected`));
    }
    const callId = this.randomId();
    const timeout = opts.timeoutMs + DEADLINE_GRACE_MS;
    return new Promise<ToolResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        this.pending.delete(callId);
        if (timer) clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        this.safeSend({ v: 1, kind: 'cancel', callId });
        resolve(failed('aborted'));
      };
      const entry: Pending = { resolve, cleanup };
      if (opts.onProgress) entry.onProgress = opts.onProgress;
      this.pending.set(callId, entry);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        this.safeSend({ v: 1, kind: 'cancel', callId });
        resolve(failed(`node '${this.name}' timed out after ${timeout} ms`));
      }, timeout);
      try {
        this.conn.send({
          v: 1,
          kind: 'call',
          callId,
          deadline: this.now() + this.skew + timeout,
          request,
        });
      } catch (err) {
        cleanup();
        resolve(failed(`could not send to node '${this.name}': ${errMsg(err)}`));
      }
    });
  }

  close(code: number, reason: string): void {
    try {
      this.conn.close(code, reason);
    } catch {
      // The socket is already gone; detach() does the bookkeeping.
    }
  }

  private safeSend(frame: ServerToNodeFrame): void {
    try {
      this.conn.send(frame);
    } catch {
      // A dead socket: detach() resolves whatever is pending.
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refuse(code: 'not_available' | 'input_invalid', error: string, reason?: string): NodePick {
  if (code === 'input_invalid') return { ok: false, result: { ok: false, code, error } };
  return {
    ok: false,
    result: reason ? { ok: false, code, error, reason } : { ok: false, code, error },
  };
}

export class NodeHub {
  private readonly entries = new Map<string, Entry>();
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(opts?: { logger?: Logger; now?: () => number; randomId?: () => string }) {
    this.logger = opts?.logger;
    this.now = opts?.now ?? Date.now;
    this.randomId = opts?.randomId ?? (() => crypto.randomUUID());
  }

  /** D16: a second connection for the same keyId evicts the first and is logged. */
  attach(keyId: string, hello: HelloFrame, conn: NodeConnection): NodeSession {
    const now = this.now();
    const prev = this.entries.get(keyId);
    let replacedAt = prev?.replacedAt;
    if (prev?.session?.isAttached) {
      this.logger?.warn('node connection replaced by a newer one', { keyId, name: prev.name });
      replacedAt = now;
      const old = prev.session;
      old.close(NODE_CLOSE.replaced, 'replaced by a newer connection');
      old.detach();
    }
    const session: SessionImpl = new SessionImpl(
      keyId,
      hello.name,
      conn,
      hello.clock - now,
      this.now,
      this.randomId,
      (s) => {
        const e = this.entries.get(keyId);
        if (e && e.session === s) {
          e.lastSeen = this.now();
          delete e.session;
        }
      },
    );
    const entry: Entry = {
      keyId,
      name: hello.name,
      roots: hello.roots,
      tools: hello.tools,
      personalities: hello.personalities,
      connectedAt: now,
      lastSeen: now,
      session,
    };
    if (replacedAt !== undefined) entry.replacedAt = replacedAt;
    // Re-pair (verification M5): a new key for a name supersedes the OFFLINE entries the old keys
    // left behind, or `node: 'lap'` stays ambiguous. Online entries are kept (D16 duplicates).
    for (const [id, e] of [...this.entries]) {
      if (id !== keyId && e.name === hello.name && !e.session) this.entries.delete(id);
    }
    this.entries.set(keyId, entry);
    return session;
  }

  /** Drops an OFFLINE entry, e.g. after its key was revoked (socket closed 4401). Never an online one. */
  forget(keyId: string): void {
    if (!this.entries.get(keyId)?.session) this.entries.delete(keyId);
  }

  /** D6: an explicit node name, or the single online node that permits this personality. */
  pick(opts: { personalityId?: string; node?: string }): NodePick {
    const permits = (e: Entry) =>
      e.personalities.includes('*') ||
      (opts.personalityId !== undefined && e.personalities.includes(opts.personalityId));
    const known = [...this.entries.values()];
    const names = known
      .map(
        (e) =>
          `'${e.name}'${e.session ? '' : ` (offline, last seen ${new Date(e.lastSeen).toISOString()})`}`,
      )
      .join(', ');

    if (opts.node !== undefined) {
      const named = known.filter((k) => k.name === opts.node);
      if (named.length > 1) {
        return refuse(
          'input_invalid',
          `several nodes are named '${opts.node}': ${named
            .map(
              (k) =>
                `key ${k.keyId} (${k.session ? 'online' : `last seen ${new Date(k.lastSeen).toISOString()}`})`,
            )
            .join(', ')}. Revoke or rename the duplicates.`,
        );
      }
      const e = named[0];
      if (!e) {
        return refuse(
          'not_available',
          `no node named '${opts.node}'. Known nodes: ${names || '(none)'}`,
        );
      }
      if (!e.session) {
        return refuse(
          'not_available',
          `node '${e.name}' is offline (last seen ${new Date(e.lastSeen).toISOString()})`,
          'node_offline',
        );
      }
      if (!permits(e)) {
        return refuse(
          'not_available',
          `node '${e.name}' does not permit personality '${opts.personalityId ?? '(none)'}'`,
        );
      }
      return { ok: true, session: e.session };
    }

    const candidates = known.filter((e) => e.session && permits(e));
    const first = candidates[0];
    if (!first?.session) {
      return refuse(
        'not_available',
        `no connected node permits this personality. Known nodes: ${names || '(none)'}`,
      );
    }
    if (candidates.length > 1) {
      return refuse(
        'input_invalid',
        `several nodes are connected: ${candidates.map((e) => `'${e.name}'`).join(', ')}. Pass the "node" argument.`,
      );
    }
    return { ok: true, session: first.session };
  }

  /** Online first, then offline nodes seen this process. */
  list(): NodeListEntry[] {
    const out = [...this.entries.values()].map((e): NodeListEntry => {
      const item: NodeListEntry = {
        name: e.name,
        keyId: e.keyId,
        online: e.session !== undefined,
        roots: e.roots,
        tools: e.tools,
        personalities: e.personalities,
        lastSeen: new Date(e.session ? this.now() : e.lastSeen).toISOString(),
      };
      if (e.connectedAt !== undefined) item.connectedAt = new Date(e.connectedAt).toISOString();
      if (e.replacedAt !== undefined) item.replacedAt = new Date(e.replacedAt).toISOString();
      return item;
    });
    return [...out.filter((e) => e.online), ...out.filter((e) => !e.online)];
  }
}
