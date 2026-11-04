import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { noopLogger } from '@ethosagent/logger';
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import type {
  Logger,
  Storage,
  ToolContext,
  ToolExecuteRequest,
  ToolResult,
} from '@ethosagent/types';
import type { HandlerTable } from './connection';
import { HostUnavailableError } from './errors';
import type { HostEventSink } from './events';
import type { LiveCall } from './handles';
import type { HostRequestOptions } from './host-calls';
import { HostEntry } from './host-entry';
import type { HandlerContext, HostRuntimeConfig, HostSpec } from './host-types';
import { createParentHandlers, ParentApis, type ParentServices } from './parent-handlers';
import type { CallHandle, ParentToHostMethod, Registration } from './protocol';

export type { HandlerContext, HostSpec } from './host-types';

export interface HostEnvContext {
  pluginId: string;
  hostHome: string;
  tmpDir: string;
}

export interface PluginHostPoolOptions {
  /** Used only for `mkdir` of the host dirs; no raw node:fs in this package. */
  storage: Storage;
  dataDir: string;
  /** Absolute path of the child entry (`apps/ethos/src/plugin-host-child.ts` or its bundle). */
  childEntry: string;
  /** Replaces the default `[--import tsx] <entry>` argv (node flags are added by the pool). */
  launchArgs?: (childEntry: string) => string[];
  /** Lane C swaps in `minimalHostEnv`-based scrubbing here. */
  buildEnv?: (ctx: HostEnvContext) => Record<string, string>;
  /** Replaces the default host -> parent handler table (`createParentHandlers`). Tests only. */
  makeHandlers?: (ctx: HandlerContext) => HandlerTable;
  /** Injection points for the default parent handlers (secret authorisation, monitor llm). */
  parent?: ParentServices;
  onEvent?: HostEventSink;
  logger?: Logger;
  maxHeapMb?: number;
  hookTimeoutMs?: number;
  readyTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  cancelGraceMs?: number;
  shutdownGraceMs?: number;
  exitWaitMs?: number;
  termGraceMs?: number;
  voidQueueMax?: number;
  now?: () => number;
  random?: () => number;
}

/** Directory-safe form of a plugin id (`@scope/name` contains a slash). */
export function hostDirName(pluginId: string): string {
  return pluginId.replace(/\//g, '__').replace(/[^\w.@-]/g, '_');
}

function resolveTsxLoader(): string {
  try {
    const url = import.meta.resolve('tsx');
    if (url.startsWith('file:')) return url;
  } catch {
    // fall through
  }
  try {
    const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
    return pathToFileURL(join(dirname(pkg), 'dist', 'loader.mjs')).href;
  } catch {
    return 'tsx';
  }
}

/** The `--import tsx` rule of apps/ethos run-all.ts `buildChildLaunchArgs`, replicated (no imports from apps). */
export function defaultLaunchArgs(childEntry: string): string[] {
  const needsTsx = childEntry.endsWith('.ts') || childEntry.endsWith('.tsx');
  if (!needsTsx) return [childEntry];
  // The child's cwd is its private home, so a bare 'tsx' would not resolve from there.
  const loader = resolveTsxLoader();
  return ['--import', loader, childEntry];
}

export interface HostLease {
  readonly pluginId: string;
  readonly registrations: readonly Registration[];
  readonly holdsLongLived: boolean;
  callTool(request: ToolExecuteRequest, ctx: ToolContext): Promise<ToolResult>;
  isToolAvailable(name: string): boolean;
  fireVoid(name: string, payload: unknown): void;
  fireModifying(name: string, payload: unknown): Promise<Record<string, unknown> | null>;
  emitEvent: HostEventSink;
  /** Directory the host may keep plugin data in; `registerDataSource` paths must lie inside it. */
  readonly stateDir: string;
  /** Rejects with HostUnavailableError, RpcError or a timeout; callers pick the fallback. */
  request(method: ParentToHostMethod, params: unknown, opts?: HostRequestOptions): Promise<unknown>;
  notifyHost(method: ParentToHostMethod, params: unknown): void;
  /** Opens a call handle for the duration of `fn`, revoked in a `finally`. */
  withCall<T>(ctx: LiveCall, fn: (call: CallHandle) => Promise<T>): Promise<T>;
  /** Registers the parent's own `PluginApiImpl`; host-to-parent traffic is answered through it. */
  bindApi(api: EthosPluginApi): void;
  onRegistrationAdded(listener: (reg: Registration) => void): () => void;
  /** Idempotent. Releases this lease only; the host lives until the pool is disposed. */
  release(): void;
}

class Lease implements HostLease {
  private released = false;

  private boundApi: EthosPluginApi | undefined;

  constructor(
    private readonly entry: HostEntry,
    private readonly onRelease: () => void,
    readonly emitEvent: HostEventSink,
    readonly stateDir: string,
    private readonly apis: ParentApis,
  ) {}

  get pluginId(): string {
    return this.entry.spec.id;
  }
  get registrations(): readonly Registration[] {
    return this.entry.registrations;
  }
  get holdsLongLived(): boolean {
    return this.entry.holdsLongLived;
  }
  callTool(request: ToolExecuteRequest, ctx: ToolContext): Promise<ToolResult> {
    return this.entry.calls.callTool(request, ctx);
  }
  request(
    method: ParentToHostMethod,
    params: unknown,
    opts?: HostRequestOptions,
  ): Promise<unknown> {
    return this.entry.calls.request(method, params, opts);
  }
  notifyHost(method: ParentToHostMethod, params: unknown): void {
    this.entry.calls.notify(method, params);
  }
  withCall<T>(ctx: LiveCall, fn: (call: CallHandle) => Promise<T>): Promise<T> {
    return this.entry.calls.withCall(ctx, fn);
  }
  bindApi(api: EthosPluginApi): void {
    this.boundApi = api;
    this.apis.bind(this.entry.spec.id, api);
  }
  isToolAvailable(name: string): boolean {
    return this.entry.isToolAvailable(name);
  }
  fireVoid(name: string, payload: unknown): void {
    this.entry.calls.fireVoid(name, payload);
  }
  fireModifying(name: string, payload: unknown): Promise<Record<string, unknown> | null> {
    return this.entry.calls.fireModifying(name, payload);
  }
  onRegistrationAdded(listener: (reg: Registration) => void): () => void {
    return this.entry.onRegistrationAdded(listener);
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.boundApi) this.apis.unbind(this.entry.spec.id, this.boundApi);
    this.onRelease();
  }
}

/**
 * One host per plugin per Ethos process (plan §5.1, D3/D4). The app host owns
 * the pool and lends it to loops; a loop only releases its own leases, and
 * `dispose()` (memoised) is what stops the hosts.
 */
export class PluginHostPool {
  private readonly entries = new Map<string, HostEntry>();
  private readonly starting = new Map<string, Promise<HostEntry>>();
  private readonly leaseCounts = new Map<string, number>();
  private readonly cfg: HostRuntimeConfig;
  private readonly apis = new ParentApis();
  private disposing: Promise<void> | null = null;
  private tsxTsconfig: string | undefined;
  private tsxResolved = false;

  constructor(private readonly opts: PluginHostPoolOptions) {
    const buildEnv = opts.buildEnv ?? defaultEnv;
    const launch = opts.launchArgs ?? defaultLaunchArgs;
    const hostHome = (id: string): string =>
      join(opts.dataDir, 'plugin-hosts', hostDirName(id), 'home');
    this.cfg = {
      dataDir: opts.dataDir,
      hostHome,
      launchArgs: (maxHeapMb) => [`--max-old-space-size=${maxHeapMb}`, ...launch(opts.childEntry)],
      buildEnv: (id) => {
        const home = hostHome(id);
        const env = buildEnv({ pluginId: id, hostHome: home, tmpDir: join(home, '..', 'tmp') });
        // Running a .ts child from source: tsx must find the repo's path aliases from a foreign cwd.
        return this.tsxTsconfig ? { ...env, TSX_TSCONFIG_PATH: this.tsxTsconfig } : env;
      },
      makeHandlers:
        opts.makeHandlers ??
        createParentHandlers({
          ...(opts.parent ?? {}),
          storage: opts.storage,
          hostHome,
          apis: this.apis,
          onEvent: (category, payload) => this.cfg.onEvent(category, payload),
        }),
      onEvent: opts.onEvent ?? (() => undefined),
      logger: opts.logger ?? noopLogger,
      maxHeapMb: opts.maxHeapMb ?? 512,
      hookTimeoutMs: opts.hookTimeoutMs ?? 2_000,
      readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
      pingIntervalMs: opts.pingIntervalMs ?? 30_000,
      pingTimeoutMs: opts.pingTimeoutMs ?? 5_000,
      cancelGraceMs: opts.cancelGraceMs ?? 2_000,
      shutdownGraceMs: opts.shutdownGraceMs ?? 1_500,
      exitWaitMs: opts.exitWaitMs ?? 250,
      termGraceMs: opts.termGraceMs ?? 1_000,
      voidQueueMax: opts.voidQueueMax ?? 1_000,
      now: opts.now ?? Date.now,
      random: opts.random ?? Math.random,
    };
  }

  /** pid of a plugin's current host, for tests and `plugin list`. */
  pidOf(pluginId: string): number | undefined {
    return this.entries.get(pluginId)?.pid;
  }

  entry(pluginId: string): HostEntry | undefined {
    return this.entries.get(pluginId);
  }

  /**
   * Leases a plugin's host. The first lease spawns and activates; a later lease
   * gets the cached registration list without running `activate()` again.
   */
  async acquire(spec: HostSpec): Promise<HostLease> {
    if (this.disposing) throw new HostUnavailableError('plugin host pool is disposed');
    let entry = this.entries.get(spec.id);
    if (!entry) {
      let pending = this.starting.get(spec.id);
      if (!pending) {
        pending = this.createEntry(spec).finally(() => this.starting.delete(spec.id));
        this.starting.set(spec.id, pending);
      }
      entry = await pending;
    }
    this.leaseCounts.set(spec.id, (this.leaseCounts.get(spec.id) ?? 0) + 1);
    return new Lease(
      entry,
      () => {
        this.leaseCounts.set(spec.id, Math.max(0, (this.leaseCounts.get(spec.id) ?? 1) - 1));
      },
      this.cfg.onEvent,
      join(this.opts.dataDir, 'plugin-hosts', hostDirName(spec.id)),
      this.apis,
    );
  }

  leasesOf(pluginId: string): number {
    return this.leaseCounts.get(pluginId) ?? 0;
  }

  /** Dev only: the nearest tsconfig.json above a `.ts` child entry (the bundled child needs none). */
  private async resolveTsxTsconfig(): Promise<void> {
    if (this.tsxResolved) return;
    this.tsxResolved = true;
    if (!this.opts.childEntry.endsWith('.ts')) return;
    let dir = dirname(this.opts.childEntry);
    for (;;) {
      const candidate = join(dir, 'tsconfig.json');
      if (await this.opts.storage.exists(candidate)) {
        this.tsxTsconfig = candidate;
        return;
      }
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  }

  private async createEntry(spec: HostSpec): Promise<HostEntry> {
    await this.resolveTsxTsconfig();
    const home = this.cfg.hostHome(spec.id);
    await this.opts.storage.mkdir(home);
    await this.opts.storage.mkdir(join(home, '..', 'tmp'));
    const entry = new HostEntry(spec, this.cfg);
    await entry.activate();
    if (this.disposing) {
      await entry.stop('dispose');
      throw new HostUnavailableError('plugin host pool is disposed');
    }
    this.entries.set(spec.id, entry);
    return entry;
  }

  /** Memoised. Stops every host in parallel: shutdown, SIGTERM the group, SIGKILL 1 s later. */
  dispose(): Promise<void> {
    if (!this.disposing) {
      const pending = [...this.starting.values()].map((p) => p.catch(() => undefined));
      this.disposing = Promise.all(pending).then(async () => {
        await Promise.all([...this.entries.values()].map((e) => e.stop('dispose')));
      });
    }
    return this.disposing;
  }
}

function defaultEnv(ctx: HostEnvContext): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: ctx.hostHome,
    TMPDIR: ctx.tmpDir,
    ETHOS_PLUGIN_HOST: '1',
  };
}
