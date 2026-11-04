import type { ToolContext, ToolExecuteRequest, ToolResult } from '@ethosagent/types';
import { CallMetrics } from './call-metrics';
import {
  ConnectionClosedError,
  type HostConnection,
  type RequestMeta,
  RequestTimeoutError,
  RpcError,
} from './connection';
import { HostUnavailableError } from './errors';
import type { HostSpanOutcome } from './events';
import type { CallHandleTable, LiveCall } from './handles';
import type { HostRuntimeConfig, HostSpec, HostStats } from './host-types';
import type { CallHandle, LiveSnapshot, ParentToHostMethod, RpcId } from './protocol';
import { failure, parseToolResult } from './tool-result';
import { isRecord } from './util';

/** What `HostCalls` needs from the entry that owns the process. */
export interface CallSurface {
  readonly spec: HostSpec;
  readonly cfg: HostRuntimeConfig;
  readonly handles: CallHandleTable;
  readonly stats: HostStats;
  readonly drifted: Set<string>;
  readonly isRunning: boolean;
  /** True when a call may start the host on demand (never ran, or stopped for idleness). */
  readonly lazyStartable: boolean;
  /** Records activity so a host only idles after `idle_stop_minutes` without any. */
  touch(): void;
  connection(): HostConnection | undefined;
  ensureRunning(): Promise<void>;
  killGroup(signal: NodeJS.Signals): void;
}

export interface HostRequestOptions {
  timeoutMs?: number;
}

/** The live handles of a tool call that are not data (llm, context, attachment list). */
export function liveSnapshot(ctx: ToolContext): LiveSnapshot {
  return {
    llm: ctx.llm !== undefined,
    context: ctx.getContext !== undefined && ctx.setContext !== undefined,
    ...(ctx.attachments ? { attachments: ctx.attachments.list() } : {}),
  };
}

/**
 * Every parent -> host call: tool execution with abort handling, modifying and
 * void hooks, and the generic request/notify/with-call used by the injector,
 * filter, evaluator, route, command, health and extract proxies.
 */
export class HostCalls {
  private ignoredCancels = 0;
  private readonly voidQueue: Array<{ name: string; payload: unknown }> = [];
  private draining = false;
  readonly metrics = new CallMetrics();

  constructor(private readonly host: CallSurface) {}

  /** Drops queued void payloads (the host died). Returns how many. */
  dropQueued(): number {
    const dropped = this.voidQueue.length;
    this.voidQueue.length = 0;
    this.host.stats.droppedVoid += dropped;
    return dropped;
  }

  /** One request to the running host, restarting it lazily. Rejects on failure; callers choose their fallback. */
  async request(
    method: ParentToHostMethod,
    params: unknown,
    opts: HostRequestOptions = {},
  ): Promise<unknown> {
    this.host.touch();
    await this.host.ensureRunning();
    const conn = this.host.connection();
    if (!conn) throw new HostUnavailableError(`Plugin '${this.host.spec.id}' host is not running`);
    const trace = this.trace(method.replace(/^ethos\//, ''), {});
    let outcome: HostSpanOutcome = 'ok';
    try {
      return await conn.request<unknown>(method, params, {
        timeoutMs: opts.timeoutMs ?? this.host.cfg.hookTimeoutMs,
        onMeta: trace.onMeta,
      });
    } catch (err) {
      outcome = failureOutcome(err);
      if (err instanceof RequestTimeoutError) this.host.stats.timeouts++;
      throw err;
    } finally {
      this.host.touch();
      trace.end(outcome);
    }
  }

  /** A notification to the running host; dropped when it is not running. */
  notify(method: ParentToHostMethod, params: unknown): void {
    if (!this.host.isRunning) return;
    this.host.connection()?.notify(method, params);
  }

  /** Opens a call handle for `ctx` for the duration of `fn`; revoked in a `finally`. */
  async withCall<T>(ctx: LiveCall, fn: (call: CallHandle) => Promise<T>): Promise<T> {
    const handle = this.host.handles.open(ctx);
    try {
      return await fn(handle);
    } finally {
      this.host.handles.revoke(handle);
    }
  }

  async callTool(request: ToolExecuteRequest, ctx: ToolContext): Promise<ToolResult> {
    const { spec, cfg, handles, drifted } = this.host;
    const name = request.name;
    const id = spec.id;
    if (drifted.has(name)) {
      return failure(
        'not_available',
        `Plugin '${id}' tool '${name}' changed after the host restarted and is unavailable until Ethos restarts.`,
      );
    }
    this.host.touch();
    try {
      await this.host.ensureRunning();
    } catch (err) {
      return failure('not_available', err instanceof Error ? err.message : String(err));
    }
    const conn = this.host.connection();
    if (!conn) return failure('not_available', `Plugin '${id}' host is not running`);
    const handle = handles.open(ctx);
    const trace = this.trace(`tool.execute:${name}`, {
      toolCallId: request.toolCallId,
      sessionId: request.sessionId,
    });
    let outcome: HostSpanOutcome = 'error';
    let callId: RpcId | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const signal = ctx.abortSignal;
    try {
      const abortedResult = new Promise<ToolResult>((resolve) => {
        onAbort = () => {
          if (callId === undefined) return;
          conn.notify('ethos/cancel', { id: callId });
          abortTimer = setTimeout(() => {
            outcome = 'aborted';
            this.ignoredCancels++;
            if (this.ignoredCancels >= 2) this.host.killGroup('SIGKILL');
            resolve(
              failure(
                'execution_failed',
                `Aborted — plugin '${id}' did not stop '${name}' within ${cfg.cancelGraceMs} ms and is marked suspect.`,
              ),
            );
          }, cfg.cancelGraceMs);
        };
        if (signal.aborted) queueMicrotask(() => onAbort?.());
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const call = conn
        .request<unknown>(
          'ethos/tool.execute',
          { name, request, call: handle, live: liveSnapshot(ctx) },
          { onId: (rid) => (callId = rid), onMeta: trace.onMeta },
        )
        .then((raw) => {
          if (abortTimer) this.ignoredCancels = 0;
          const parsed = parseToolResult(raw);
          if (outcome !== 'aborted') {
            outcome = parsed ? (parsed.ok ? 'ok' : 'error') : 'error';
          }
          return (
            parsed ??
            failure('execution_failed', `Plugin '${id}' tool '${name}' returned a malformed result`)
          );
        });
      return await Promise.race([call, abortedResult]);
    } catch (err) {
      outcome = failureOutcome(err);
      return this.toolFailure(err, name);
    } finally {
      this.host.touch();
      trace.end(outcome);
      if (abortTimer) clearTimeout(abortTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      handles.revoke(handle);
    }
  }

  /** Starts the span for one IPC call; `end` closes it and feeds the host's stats window. */
  private trace(
    name: string,
    ids: { toolCallId?: string; sessionId?: string },
  ): { onMeta: (meta: RequestMeta) => void; end: (outcome: HostSpanOutcome) => void } {
    const t0 = performance.now();
    let meta: RequestMeta | undefined;
    let finish: ReturnType<NonNullable<HostRuntimeConfig['onSpan']>> | undefined;
    try {
      finish = this.host.cfg.onSpan?.({
        name,
        pluginId: this.host.spec.id,
        ...(ids.toolCallId ? { toolCallId: ids.toolCallId } : {}),
        ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
      });
    } catch {
      // observability must not break a call
    }
    return {
      onMeta: (m) => {
        meta = m;
      },
      end: (outcome) => {
        const ipcMs = performance.now() - t0;
        this.metrics.record(ipcMs, meta?.reqBytes ?? 0, meta?.resBytes ?? 0);
        try {
          finish?.({
            outcome,
            reqBytes: meta?.reqBytes ?? 0,
            resBytes: meta?.resBytes ?? 0,
            ipcMs,
            ...(meta?.hostMs !== undefined ? { hostMs: meta.hostMs } : {}),
          });
        } catch {
          // observability must not break a call
        }
      },
    };
  }

  private toolFailure(err: unknown, tool: string): ToolResult {
    const id = this.host.spec.id;
    if (err instanceof ConnectionClosedError) {
      return failure(
        'execution_failed',
        `Plugin '${id}' ${err.message} while '${tool}' was running, so it may or may not have taken effect.`,
      );
    }
    if (err instanceof RpcError) {
      return failure('execution_failed', `Plugin '${id}' tool '${tool}' failed: ${err.message}`);
    }
    return failure(
      'execution_failed',
      `Plugin '${id}' tool '${tool}' could not be called: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /** Runs the plugin's modifying handlers host-side. Timeout, crash or throw: null (fail-open). */
  async fireModifying(name: string, payload: unknown): Promise<Record<string, unknown> | null> {
    this.host.touch();
    if (!this.host.isRunning && this.host.lazyStartable) {
      // Never ran (registration cache hit) or stopped for idleness: start it so this hook sees it.
      try {
        await this.host.ensureRunning();
      } catch {
        return null;
      }
    }
    const conn = this.host.connection();
    if (!this.host.isRunning || !conn) {
      void this.host.ensureRunning().catch(() => undefined);
      return null;
    }
    const trace = this.trace(`hook.fire:${name}`, {});
    let outcome: HostSpanOutcome = 'ok';
    try {
      const raw = await conn.request<unknown>(
        'ethos/hook.fire',
        { model: 'modifying', name, payload },
        { timeoutMs: this.host.cfg.hookTimeoutMs, onMeta: trace.onMeta },
      );
      return isRecord(raw) ? raw : null;
    } catch (err) {
      outcome = failureOutcome(err);
      if (err instanceof RequestTimeoutError) this.host.stats.timeouts++;
      return null;
    } finally {
      this.host.touch();
      trace.end(outcome);
    }
  }

  /** Fire-and-forget, FIFO per host, bounded queue that drops the oldest (D10). */
  fireVoid(name: string, payload: unknown): void {
    const cold = !this.host.isRunning;
    if (cold && !this.host.lazyStartable) {
      this.host.stats.droppedVoid++;
      return;
    }
    this.host.touch();
    this.voidQueue.push({ name, payload });
    while (this.voidQueue.length > this.host.cfg.voidQueueMax) {
      this.voidQueue.shift();
      this.host.stats.droppedVoid++;
    }
    if (cold) {
      // Start the host on demand (cache hit or idle stop), then drain what queued meanwhile.
      this.host
        .ensureRunning()
        .then(() => this.drainVoid())
        .catch(() => void this.dropQueued());
      return;
    }
    void this.drainVoid();
  }

  private async drainVoid(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.voidQueue.length > 0) {
        const conn = this.host.connection();
        if (!this.host.isRunning || !conn) break;
        const item = this.voidQueue.shift();
        if (!item) break;
        const trace = this.trace(`hook.fire:${item.name}`, {});
        let outcome: HostSpanOutcome = 'ok';
        try {
          await conn.request(
            'ethos/hook.fire',
            { model: 'void', name: item.name, payload: item.payload },
            { timeoutMs: this.host.cfg.hookTimeoutMs, onMeta: trace.onMeta },
          );
        } catch (err) {
          outcome = failureOutcome(err);
          if (err instanceof RequestTimeoutError) this.host.stats.timeouts++;
        } finally {
          this.host.touch();
          trace.end(outcome);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function failureOutcome(err: unknown): HostSpanOutcome {
  if (err instanceof RequestTimeoutError) return 'timeout';
  if (err instanceof HostUnavailableError) return 'unavailable';
  return 'error';
}
