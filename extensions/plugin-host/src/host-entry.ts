import { type ChildProcess, spawn } from 'node:child_process';
import type { Logger, ToolContext, ToolExecuteRequest, ToolResult } from '@ethosagent/types';
import {
  BACKOFF_CAP_MS,
  backoffDelay,
  CIRCUIT_CRASH_LIMIT,
  CIRCUIT_OPEN_MS,
  HEALTHY_UPTIME_MS,
  recentCrashes,
} from './backoff';
import {
  ConnectionClosedError,
  type HandlerTable,
  HostConnection,
  RequestTimeoutError,
  RpcError,
} from './connection';
import { HostStartError, HostUnavailableError } from './errors';
import type { HostEventSink } from './events';
import { CallHandleTable } from './handles';
import {
  type ActivateParams,
  type ActivateResult,
  PROTOCOL_VERSION,
  type Registration,
  type RpcId,
} from './protocol';
import { parseRegistration } from './registration-parse';
import { failure, parseToolResult } from './tool-result';

/** What the pool tells an entry about one plugin. */
export interface HostSpec {
  id: string;
  dir: string;
  entry?: string;
  tier?: string;
  baseUrl?: string;
  /** Secret key NAMES for the child's `hasSecret` (D19). */
  secretKeys?: string[];
}

/** Resolved settings, owned by the pool and shared by every entry. */
export interface HostRuntimeConfig {
  dataDir: string;
  hostHome: (id: string) => string;
  launchArgs: (maxHeapMb: number) => string[];
  buildEnv: (id: string) => Record<string, string>;
  makeHandlers: (ctx: { pluginId: string; handles: CallHandleTable }) => HandlerTable;
  onEvent: HostEventSink;
  logger: Logger;
  maxHeapMb: number;
  hookTimeoutMs: number;
  readyTimeoutMs: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  cancelGraceMs: number;
  shutdownGraceMs: number;
  exitWaitMs: number;
  termGraceMs: number;
  voidQueueMax: number;
  now: () => number;
  random: () => number;
}

type State = 'idle' | 'starting' | 'running' | 'backoff' | 'circuit' | 'stopped';

interface Running {
  proc: ChildProcess;
  conn: HostConnection;
  exited: Promise<void>;
  startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeExit(code: number | null, signal: string | null): string {
  return signal ?? `code ${code}`;
}

function comparable(reg: Registration): string {
  if (reg.kind === 'tool') {
    const { available: _available, ...rest } = reg;
    return JSON.stringify(rest);
  }
  return JSON.stringify(reg);
}

function regKey(reg: Registration): string {
  return `${reg.kind}:${reg.kind === 'tool' ? reg.name : `${reg.model}:${reg.name}`}`;
}

/**
 * One plugin's host: the child process, its connection and its failure
 * bookkeeping (plan §5.4). Owned by `PluginHostPool`; borrowers use leases.
 */
export class HostEntry {
  readonly handles = new CallHandleTable();
  registrations: Registration[] = [];
  holdsLongLived = false;
  /** Tools whose registration changed across a restart: not_available until process restart. */
  readonly drifted = new Set<string>();
  readonly toolAvailable = new Map<string, boolean>();
  readonly stats = { droppedVoid: 0, timeouts: 0, restarts: 0 };

  private state: State = 'idle';
  private current: Running | null = null;
  private startPromise: Promise<void> | null = null;
  private activated = false;
  private crashes: number[] = [];
  private consecutive = 0;
  private nextSpawnAt = 0;
  private circuitUntil = 0;
  private stopping = false;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private ignoredCancels = 0;
  private stderrTail = '';
  private stderrWindowStart = 0;
  private stderrLines = 0;
  private readonly voidQueue: Array<{ name: string; payload: unknown }> = [];
  private draining = false;
  private readonly addedListeners = new Set<(reg: Registration) => void>();

  constructor(
    readonly spec: HostSpec,
    private readonly cfg: HostRuntimeConfig,
  ) {}

  get pid(): number | undefined {
    return this.current?.proc.pid;
  }

  get connectionStats():
    | { strayResponses: number; duplicateResponses: number; violations: number }
    | undefined {
    return this.current?.conn.stats;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  onRegistrationAdded(listener: (reg: Registration) => void): () => void {
    this.addedListeners.add(listener);
    return () => this.addedListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Start / restart
  // -------------------------------------------------------------------------

  /** First activation. Rejects (and leaves nothing running) when the host cannot start. */
  async activate(): Promise<void> {
    await this.begin(false);
  }

  private begin(isRestart: boolean): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.state = 'starting';
    const p = this.startOnce(isRestart).finally(() => {
      this.startPromise = null;
    });
    this.startPromise = p;
    return p;
  }

  private async startOnce(isRestart: boolean): Promise<void> {
    const t0 = this.cfg.now();
    let running: Running | null = null;
    try {
      running = await this.spawnAndWaitReady();
      this.current = running;
      const result = await running.conn.request<unknown>('ethos/activate', this.activateParams(), {
        timeoutMs: this.cfg.readyTimeoutMs * 3,
      });
      const parsed = this.parseActivate(result);
      this.applyActivation(parsed, isRestart);
      this.state = 'running';
      this.cfg.onEvent('plugin_host.spawned', {
        plugin_id: this.spec.id,
        pid: running.proc.pid,
        spawn_ms: this.cfg.now() - t0,
      });
      if (isRestart) {
        this.stats.restarts++;
        this.cfg.onEvent('plugin_host.restarted', {
          plugin_id: this.spec.id,
          attempt: this.consecutive,
          backoff_ms: Math.max(0, this.cfg.now() - t0),
        });
      }
      this.schedulePing();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (running) {
        this.killGroup('SIGKILL');
        await running.exited.catch(() => undefined);
      }
      if (this.current === running) this.current = null;
      if (isRestart) this.recordCrash(running?.startedAt ?? t0);
      else this.state = 'idle';
      throw err instanceof HostStartError ? err : new HostStartError(message);
    }
  }

  private activateParams(): ActivateParams {
    return {
      pluginId: this.spec.id,
      dir: this.spec.dir,
      ...(this.spec.entry ? { entry: this.spec.entry } : {}),
      ...(this.spec.tier ? { tier: this.spec.tier } : {}),
      dataDir: this.cfg.dataDir,
      hostHome: this.cfg.hostHome(this.spec.id),
      ...(this.spec.baseUrl ? { baseUrl: this.spec.baseUrl } : {}),
      secretKeys: this.spec.secretKeys ?? [],
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  private parseActivate(raw: unknown): ActivateResult {
    if (!isRecord(raw) || !Array.isArray(raw.registrations)) {
      throw new HostStartError(`Plugin '${this.spec.id}' host returned a malformed activation`);
    }
    const registrations: Registration[] = [];
    for (const item of raw.registrations) {
      const reg = parseRegistration(item);
      if (reg) registrations.push(reg);
    }
    return { registrations, holdsLongLived: raw.holdsLongLived === true };
  }

  private applyActivation(result: ActivateResult, isRestart: boolean): void {
    if (!this.activated) {
      this.activated = true;
      this.registrations = result.registrations;
      this.holdsLongLived = result.holdsLongLived;
      for (const reg of result.registrations) {
        if (reg.kind === 'tool') this.toolAvailable.set(reg.name, reg.available);
      }
      return;
    }
    if (!isRestart) return;
    const before = new Map(this.registrations.map((r) => [regKey(r), comparable(r)]));
    const after = new Map(result.registrations.map((r) => [regKey(r), comparable(r)]));
    const changed: string[] = [];
    for (const [key, sig] of before) if (after.get(key) !== sig) changed.push(key);
    for (const key of after.keys()) if (!before.has(key)) changed.push(key);
    for (const reg of result.registrations) {
      if (reg.kind === 'tool') this.toolAvailable.set(reg.name, reg.available);
    }
    if (changed.length > 0) {
      for (const key of changed) {
        if (key.startsWith('tool:')) this.drifted.add(key.slice('tool:'.length));
      }
      this.cfg.onEvent('plugin_host.registration_drift', {
        plugin_id: this.spec.id,
        changed,
      });
    }
  }

  private spawnAndWaitReady(): Promise<Running> {
    const cfg = this.cfg;
    const id = this.spec.id;
    const home = cfg.hostHome(id);
    const startedAt = cfg.now();
    return new Promise<Running>((resolve, reject) => {
      let settled = false;
      let proc: ChildProcess;
      try {
        proc = spawn(process.execPath, cfg.launchArgs(cfg.maxHeapMb), {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          env: cfg.buildEnv(id),
          cwd: home,
        });
      } catch (err) {
        reject(new HostStartError(`Plugin '${id}' host failed to spawn: ${String(err)}`));
        return;
      }
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      let onExited: () => void = () => undefined;
      const exited = new Promise<void>((res) => {
        onExited = res;
      });
      const fail = (msg: string): void => {
        if (settled) return;
        settled = true;
        if (readyTimer) clearTimeout(readyTimer);
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // already gone
        }
        reject(new HostStartError(msg));
      };

      const handlers = cfg.makeHandlers({ pluginId: id, handles: this.handles });
      const conn: HostConnection = new HostConnection({
        write: (line) => {
          proc.stdin?.write(line);
        },
        handlers,
        onViolation: (reason) => this.onViolation(reason, proc),
        onNotification: (method, params) => {
          if (method === 'ethos/ready' && !settled) {
            settled = true;
            if (readyTimer) clearTimeout(readyTimer);
            resolve({ proc, conn, exited, startedAt });
          } else if (method === 'ethos/log') {
            this.forwardLog(params);
          } else if (method === 'ethos/registration.added') {
            this.onRegistrationAdded0(params);
          }
        },
      });

      proc.stdin?.on('error', () => undefined);
      proc.stdout?.on('data', (chunk: Buffer) => conn.feed(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => this.forwardStderr(chunk));
      proc.on('error', (err) => {
        fail(`Plugin '${id}' host failed to spawn: ${err.message}`);
        onExited();
      });
      proc.on('exit', (code, signal) => {
        const inFlight = conn.pendingCount;
        if (!settled) {
          fail(
            `Plugin '${id}' host exited (${describeExit(code, signal)}) before it was ready${this.tail()}`,
          );
        }
        conn.close(
          new ConnectionClosedError(`host exited (${describeExit(code, signal)})`, {
            code,
            signal,
          }),
        );
        onExited();
        this.handleExit(proc, code, signal, inFlight);
      });
      readyTimer = setTimeout(
        () => fail(`Plugin '${id}' host did not become ready within ${cfg.readyTimeoutMs} ms`),
        cfg.readyTimeoutMs,
      );
    });
  }

  private tail(): string {
    const t = this.stderrTail.trim();
    return t === '' ? '' : `: ${t.slice(0, 500)}`;
  }

  private onViolation(reason: string, proc: ChildProcess): void {
    this.cfg.logger.warn(`[plugin-host] '${this.spec.id}' protocol violation: ${reason}`, {
      component: 'plugin-host',
      pluginId: this.spec.id,
    });
    this.cfg.onEvent('plugin_host.denied', {
      plugin_id: this.spec.id,
      kind: 'protocol',
      ref: reason,
    });
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }

  private onRegistrationAdded0(params: unknown): void {
    if (!isRecord(params)) return;
    const reg = parseRegistration(params.registration);
    if (!reg) return;
    this.registrations.push(reg);
    if (reg.kind === 'tool') this.toolAvailable.set(reg.name, reg.available);
    for (const listener of this.addedListeners) listener(reg);
  }

  private forwardLog(params: unknown): void {
    if (!isRecord(params) || typeof params.message !== 'string') return;
    this.cfg.logger.debug(`[plugin-host:${this.spec.id}] ${params.message}`, {
      component: 'plugin-host',
    });
  }

  /** stderr is the plugin's console. Forwarded at debug, at most 50 lines per second. */
  private forwardStderr(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2_000);
    const now = this.cfg.now();
    if (now - this.stderrWindowStart >= 1000) {
      this.stderrWindowStart = now;
      this.stderrLines = 0;
    }
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line === '') continue;
      if (++this.stderrLines > 50) return;
      this.cfg.logger.debug(`[plugin-host:${this.spec.id}] ${line}`, { component: 'plugin-host' });
    }
  }

  // -------------------------------------------------------------------------
  // Exit, crash, restart
  // -------------------------------------------------------------------------

  private handleExit(
    proc: ChildProcess,
    code: number | null,
    signal: string | null,
    inFlight: number,
  ): void {
    if (this.current?.proc !== proc) return;
    const running = this.current;
    this.current = null;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    const dropped = this.voidQueue.length;
    this.voidQueue.length = 0;
    this.stats.droppedVoid += dropped;
    if (this.stopping || this.state === 'stopped') {
      this.state = 'stopped';
      return;
    }
    if (this.state === 'starting') return; // the start path accounts for it
    this.cfg.onEvent('plugin_host.crashed', {
      plugin_id: this.spec.id,
      code,
      signal,
      in_flight: inFlight,
    });
    this.recordCrash(running.startedAt);
  }

  private recordCrash(startedAt: number): void {
    const now = this.cfg.now();
    this.crashes = recentCrashes([...this.crashes, now], now);
    this.consecutive = now - startedAt >= HEALTHY_UPTIME_MS ? 1 : this.consecutive + 1;
    if (this.crashes.length >= CIRCUIT_CRASH_LIMIT) {
      this.state = 'circuit';
      this.circuitUntil = now + CIRCUIT_OPEN_MS;
      this.cfg.onEvent('plugin_host.circuit_open', {
        plugin_id: this.spec.id,
        crashes: this.crashes.length,
        reopen_ms: CIRCUIT_OPEN_MS,
      });
      return;
    }
    const delay = backoffDelay(this.consecutive, this.cfg.random);
    this.nextSpawnAt = now + delay;
    this.state = 'backoff';
    if (this.holdsLongLived) {
      this.restartTimer = setTimeout(
        () => {
          void this.ensureRunning().catch(() => undefined);
        },
        Math.min(delay, BACKOFF_CAP_MS * 2),
      );
      this.restartTimer.unref?.();
    }
  }

  /** Resolves when a call may be sent, restarting the host lazily; throws HostUnavailableError. */
  async ensureRunning(): Promise<void> {
    const now = this.cfg.now();
    switch (this.state) {
      case 'running':
        return;
      case 'starting':
        await this.startPromise;
        return;
      case 'stopped':
        throw new HostUnavailableError(`Plugin '${this.spec.id}' host is stopped`);
      case 'circuit':
        if (now < this.circuitUntil) {
          throw new HostUnavailableError('plugin host disabled after repeated crashes');
        }
        this.crashes = [];
        this.consecutive = 0;
        break;
      case 'backoff':
        if (now < this.nextSpawnAt) {
          const secs = Math.ceil((this.nextSpawnAt - now) / 1000);
          throw new HostUnavailableError(
            `Plugin '${this.spec.id}' host is restarting after a crash (retry in ${secs}s)`,
          );
        }
        break;
      default:
        break;
    }
    try {
      await this.begin(true);
    } catch (err) {
      throw new HostUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  private schedulePing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    const running = this.current;
    if (!running) return;
    this.pingTimer = setTimeout(() => {
      void this.ping(running);
    }, this.cfg.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private async ping(running: Running): Promise<void> {
    if (this.current !== running) return;
    try {
      const raw = await running.conn.request<unknown>(
        'ethos/ping',
        {},
        { timeoutMs: this.cfg.pingTimeoutMs },
      );
      if (isRecord(raw) && isRecord(raw.tools)) {
        for (const [name, avail] of Object.entries(raw.tools)) {
          if (typeof avail === 'boolean') this.toolAvailable.set(name, avail);
        }
      }
      this.schedulePing();
    } catch (err) {
      if (this.current !== running) return;
      this.cfg.logger.warn(
        `[plugin-host] '${this.spec.id}' missed a ping, killing: ${String(err)}`,
        {
          component: 'plugin-host',
        },
      );
      this.killGroup('SIGKILL');
    }
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  isToolAvailable(name: string): boolean {
    if (this.drifted.has(name)) return false;
    if (this.state === 'circuit' || this.state === 'stopped') return false;
    return this.toolAvailable.get(name) ?? false;
  }

  async callTool(request: ToolExecuteRequest, ctx: ToolContext): Promise<ToolResult> {
    const name = request.name;
    const id = this.spec.id;
    if (this.drifted.has(name)) {
      return failure(
        'not_available',
        `Plugin '${id}' tool '${name}' changed after the host restarted and is unavailable until Ethos restarts.`,
      );
    }
    try {
      await this.ensureRunning();
    } catch (err) {
      return failure('not_available', err instanceof Error ? err.message : String(err));
    }
    const running = this.current;
    if (!running) return failure('not_available', `Plugin '${id}' host is not running`);
    const handle = this.handles.open(ctx);
    let callId: RpcId | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const signal = ctx.abortSignal;
    try {
      const abortedResult = new Promise<ToolResult>((resolve) => {
        onAbort = () => {
          if (callId === undefined) return;
          running.conn.notify('ethos/cancel', { id: callId });
          abortTimer = setTimeout(() => {
            this.ignoredCancels++;
            if (this.ignoredCancels >= 2) this.killGroup('SIGKILL');
            resolve(
              failure(
                'execution_failed',
                `Aborted — plugin '${id}' did not stop '${name}' within ${this.cfg.cancelGraceMs} ms and is marked suspect.`,
              ),
            );
          }, this.cfg.cancelGraceMs);
        };
        if (signal.aborted) queueMicrotask(() => onAbort?.());
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const call = running.conn
        .request<unknown>(
          'ethos/tool.execute',
          { name, request, call: handle },
          { onId: (rid) => (callId = rid) },
        )
        .then((raw) => {
          if (abortTimer) this.ignoredCancels = 0;
          return (
            parseToolResult(raw) ??
            failure('execution_failed', `Plugin '${id}' tool '${name}' returned a malformed result`)
          );
        });
      return await Promise.race([call, abortedResult]);
    } catch (err) {
      return this.toolFailure(err, name);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      this.handles.revoke(handle);
    }
  }

  private toolFailure(err: unknown, tool: string): ToolResult {
    const id = this.spec.id;
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
    const running = this.current;
    if (this.state !== 'running' || !running) {
      void this.ensureRunning().catch(() => undefined);
      return null;
    }
    try {
      const raw = await running.conn.request<unknown>(
        'ethos/hook.fire',
        { model: 'modifying', name, payload },
        { timeoutMs: this.cfg.hookTimeoutMs },
      );
      return isRecord(raw) ? raw : null;
    } catch (err) {
      if (err instanceof RequestTimeoutError) this.stats.timeouts++;
      return null;
    }
  }

  /** Fire-and-forget, FIFO per host, bounded queue that drops the oldest (D10). */
  fireVoid(name: string, payload: unknown): void {
    if (this.state !== 'running') {
      this.stats.droppedVoid++;
      return;
    }
    this.voidQueue.push({ name, payload });
    while (this.voidQueue.length > this.cfg.voidQueueMax) {
      this.voidQueue.shift();
      this.stats.droppedVoid++;
    }
    void this.drainVoid();
  }

  private async drainVoid(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.voidQueue.length > 0) {
        const running = this.current;
        if (this.state !== 'running' || !running) break;
        const item = this.voidQueue.shift();
        if (!item) break;
        try {
          await running.conn.request(
            'ethos/hook.fire',
            { model: 'void', name: item.name, payload: item.payload },
            { timeoutMs: this.cfg.hookTimeoutMs },
          );
        } catch (err) {
          if (err instanceof RequestTimeoutError) this.stats.timeouts++;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  /** Pool-level pending count, for the in-flight figure of the crash event. */
  get pendingCalls(): number {
    return this.current?.conn.pendingCount ?? 0;
  }

  killGroup(signal: NodeJS.Signals): void {
    const pid = this.current?.proc.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone
    }
  }

  /**
   * ethos/shutdown (the host awaits deactivate, at most 1.5 s), then SIGTERM to
   * the process group, then SIGKILL 1 s later. Worst case 2.75 s.
   */
  async stop(reason: 'dispose' | 'idle'): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.stopping = true;
    const running = this.current;
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    const live = this.current ?? running;
    this.state = 'stopped';
    if (!live) return;
    const pid = live.proc.pid;
    const waitExit = (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        void live.exited.then(() => {
          clearTimeout(t);
          resolve(true);
        });
      });
    try {
      await live.conn.request('ethos/shutdown', {}, { timeoutMs: this.cfg.shutdownGraceMs });
    } catch {
      // timed out, or the host is already gone
    }
    if (!(await waitExit(this.cfg.exitWaitMs))) {
      try {
        if (pid) process.kill(-pid, 'SIGTERM');
      } catch {
        // gone
      }
      if (!(await waitExit(this.cfg.termGraceMs))) {
        try {
          if (pid) process.kill(-pid, 'SIGKILL');
        } catch {
          // gone
        }
        await waitExit(250);
      }
    }
    this.cfg.onEvent('plugin_host.stopped', { plugin_id: this.spec.id, reason });
  }
}
