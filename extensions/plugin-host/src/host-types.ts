import type { ChildProcess } from 'node:child_process';
import type { Logger } from '@ethosagent/types';
import type { HandlerTable, HostConnection } from './connection';
import type { HostEventSink, HostSpanSink } from './events';
import type { CallHandleTable } from './handles';
import type { ParentToHostMethod } from './protocol';

/** What the pool tells an entry about one plugin. */
export interface HostSpec {
  id: string;
  dir: string;
  entry?: string;
  tier?: string;
  baseUrl?: string;
  /** Secret key NAMES for the child's `hasSecret` (D19). */
  secretKeys?: string[];
  /** The grant's declared `ethos.permissions.network`: `null` = nothing declared (sandbox denies network). */
  network?: string[] | null;
}

/** Counters a host accumulates; the pool and tests read them. */
export interface HostStats {
  droppedVoid: number;
  timeouts: number;
  restarts: number;
  /** Event-bus payloads that were not JSON-serialisable, in either direction (plan §4.2). */
  droppedBus: number;
}

/** What the pool hands the per-host handler factory (host -> parent requests). */
export interface HandlerContext {
  pluginId: string;
  handles: CallHandleTable;
  stats: HostStats;
  /** A notification to this spawn's host (bus events). Dropped when the host is not running. */
  notifyHost: (method: ParentToHostMethod, params: unknown) => void;
}

/** Resolved settings, owned by the pool and shared by every entry. */
export interface HostRuntimeConfig {
  dataDir: string;
  hostHome: (id: string) => string;
  launchArgs: (maxHeapMb: number) => string[];
  buildEnv: (id: string) => Record<string, string>;
  /** `sandbox: auto`: wraps the node argv in the OS sandbox wrapper. Identity when unsandboxed. */
  wrapLaunch: (
    spec: HostSpec,
    command: string,
    args: string[],
  ) => { command: string; args: string[] };
  /** True under `sandbox: auto`; an exit before `ethos/ready` is then reported as a wrapper failure (D22). */
  sandboxed: boolean;
  makeHandlers: (ctx: HandlerContext) => HandlerTable;
  onEvent: HostEventSink;
  onSpan?: HostSpanSink;
  /** Cadence of `plugin_host.stats` per running host. */
  statsIntervalMs: number;
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

export type HostState = 'idle' | 'starting' | 'running' | 'backoff' | 'circuit' | 'stopped';

export interface Running {
  proc: ChildProcess;
  conn: HostConnection;
  exited: Promise<void>;
  startedAt: number;
}

export function describeExit(code: number | null, signal: string | null): string {
  return signal ?? `code ${code}`;
}
