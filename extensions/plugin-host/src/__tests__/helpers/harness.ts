import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Logger, ToolContext, ToolExecuteRequest, ToolResult } from '@ethosagent/types';
import type { HostEventCategory } from '../../events';
import { PluginHostPool, type PluginHostPoolOptions } from '../../pool';

const here = import.meta.dirname;
export const CHILD_ENTRY = join(here, 'child-entry.ts');
export const MOCK_HOST = join(here, 'mock-host.mjs');
export const fixtureDir = (name: string): string => join(here, '..', 'fixtures', name);

export interface RecordedEvent {
  category: HostEventCategory;
  payload: Record<string, unknown>;
}

export interface Harness {
  pool: PluginHostPool;
  dataDir: string;
  events: RecordedEvent[];
  debugLines: string[];
  /** Controllable clock; advance with `clock.ms += n`. */
  clock: { ms: number };
  cleanup(): Promise<void>;
}

const captureLogger = (lines: string[]): Logger => {
  const logger: Logger = {
    debug: (m) => void lines.push(m),
    info: () => undefined,
    warn: (m) => void lines.push(m),
    error: (m) => void lines.push(m),
    child: () => logger,
  };
  return logger;
};

export interface HarnessOptions extends Partial<PluginHostPoolOptions> {
  mockMode?: string;
}

/** A pool over a temp data dir. `mockMode` swaps the child for mock-host.mjs. */
export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'plugin-host-'));
  const events: RecordedEvent[] = [];
  const debugLines: string[] = [];
  const clock = { ms: 1_000_000 };
  const { mockMode, ...rest } = opts;
  const mock = mockMode !== undefined;
  const pool = new PluginHostPool({
    storage: new FsStorage(),
    dataDir,
    childEntry: mock ? MOCK_HOST : CHILD_ENTRY,
    onEvent: (category, payload) => events.push({ category, payload }),
    logger: captureLogger(debugLines),
    now: () => clock.ms,
    random: () => 0.5,
    ...(mock
      ? {
          buildEnv: (ctx) => ({
            PATH: process.env.PATH ?? '',
            HOME: ctx.hostHome,
            MOCK_MODE: mockMode,
          }),
        }
      : {}),
    ...rest,
  });
  return {
    pool,
    dataDir,
    events,
    debugLines,
    clock,
    async cleanup() {
      await pool.dispose();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function makeRequest(name: string, args: unknown = {}): ToolExecuteRequest {
  return {
    toolCallId: `call-${name}`,
    name,
    args,
    sessionId: 's1',
    sessionKey: 'cli:s1',
    platform: 'cli',
    workingDir: process.cwd(),
    currentTurn: 1,
    messageCount: 1,
    resultBudgetChars: 80_000,
  };
}

export function makeCtx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionId: 's1',
    sessionKey: 'cli:s1',
    platform: 'cli',
    workingDir: process.cwd(),
    currentTurn: 1,
    messageCount: 1,
    resultBudgetChars: 80_000,
    abortSignal: signal,
    emit: () => undefined,
  };
}

/** Calls a hosted tool through a lease the way a proxy would. */
export async function callTool(
  lease: { callTool(r: ToolExecuteRequest, c: ToolContext): Promise<ToolResult> },
  name: string,
  args: unknown = {},
  signal?: AbortSignal,
): Promise<ToolResult> {
  return lease.callTool(makeRequest(name, args), makeCtx(signal));
}

export function eventsOf(h: Harness, category: HostEventCategory): RecordedEvent[] {
  return h.events.filter((e) => e.category === category);
}

export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
