import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAlive,
  loadRegistry,
  type ProcessStatus,
  reapStale,
  saveRegistry,
  updateEntry,
  withRegistryLock,
} from './registry';
import { rotateLogIfNeeded } from './spawn';

// Shared list/logs/stop logic, factored out so both the `process` tool family
// and the `ethos process` CLI command call the exact same code path. The tools
// in `index.ts` wrap these into the ToolResult envelope; the CLI renders them
// directly.

export const DEFAULT_LOG_LINES = 200;
const SIGTERM_GRACE_MS = 5_000;
const WAIT_POLL_MS = 200;
export const STOP_SUPPORTED_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;
export type StopSignal = (typeof STOP_SUPPORTED_SIGNALS)[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLastLines(path: string, n: number, prefix: string): string[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  // remove trailing empty line that split creates
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).map((l) => `[${prefix}] ${l}`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ProcessListItem {
  id: string;
  name: string;
  pid: number;
  status: ProcessStatus;
  started_at: string;
  exit_code?: number;
  duration_ms: number;
}

/**
 * List all tracked processes. Runs the liveness check (marking dead `running`
 * entries as `orphan`), reaps stale terminal entries, and rotates oversized
 * logs of non-running processes — identical behaviour to the `process_list`
 * tool.
 */
export async function listProcesses(dataDir: string): Promise<ProcessListItem[]> {
  const registry = await withRegistryLock(dataDir, () => {
    let reg = loadRegistry(dataDir);

    let dirty = false;
    for (const entry of Object.values(reg)) {
      if (entry.status !== 'running') continue;
      if (!isAlive(entry.pid)) {
        reg[entry.id] = {
          ...entry,
          status: 'orphan',
          lastTouchedAt: new Date().toISOString(),
        };
        dirty = true;
      }
    }

    reg = reapStale(reg);

    if (dirty) saveRegistry(dataDir, reg);
    return reg;
  });

  // rotate-on-touch: only safe for terminal processes (no live fd).
  for (const entry of Object.values(registry)) {
    if (entry.status === 'running') continue;
    const procDir = join(dataDir, 'processes', entry.id);
    rotateLogIfNeeded(join(procDir, 'stdout.log'));
    rotateLogIfNeeded(join(procDir, 'stderr.log'));
  }

  const now = Date.now();
  return Object.values(registry).map((e) => ({
    id: e.id,
    name: e.name,
    pid: e.pid,
    status: e.status,
    started_at: e.startedAt,
    ...(e.exitCode !== undefined ? { exit_code: e.exitCode } : {}),
    duration_ms: now - new Date(e.startedAt).getTime(),
  }));
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export type LogsResult = { ok: true; lines: string[] } | { ok: false; error: string };

/**
 * Read the last N lines from a process's logs. `stream: 'both'` (the default)
 * interleaves stdout then stderr, taking the last N of the combined set —
 * identical behaviour to the `process_logs` tool.
 */
export async function readProcessLogs(
  dataDir: string,
  id: string,
  opts: { lines?: number; stream?: 'stdout' | 'stderr' | 'both' },
): Promise<LogsResult> {
  const registry = loadRegistry(dataDir);
  const entry = registry[id];
  if (!entry) {
    return { ok: false, error: `PROCESS_NOT_FOUND: process ${id} not found` };
  }

  const n = opts.lines ?? DEFAULT_LOG_LINES;
  const which = opts.stream ?? 'both';
  const dir = join(dataDir, 'processes', id);
  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');

  let combined: string[];
  if (which === 'stdout') {
    combined = readLastLines(stdoutPath, n, 'stdout');
  } else if (which === 'stderr') {
    combined = readLastLines(stderrPath, n, 'stderr');
  } else {
    const out = readLastLines(stdoutPath, n, 'stdout');
    const err = readLastLines(stderrPath, n, 'stderr');
    combined = [...out, ...err].slice(-n);
  }

  // rotate-on-touch: only safe once the process is terminal (no live fd).
  if (entry.status !== 'running') {
    rotateLogIfNeeded(stdoutPath);
    rotateLogIfNeeded(stderrPath);
  }

  return { ok: true, lines: combined };
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

export type StopResult =
  | { ok: true; stopped: boolean; exit_code?: number }
  | { ok: false; error: string };

/**
 * Send a signal to stop a running process. SIGTERM waits up to 5s for a
 * graceful exit then escalates to SIGKILL — identical behaviour to the
 * `process_stop` tool.
 */
export async function stopProcess(
  dataDir: string,
  id: string,
  signal: StopSignal = 'SIGTERM',
): Promise<StopResult> {
  if (!STOP_SUPPORTED_SIGNALS.includes(signal)) {
    return {
      ok: false,
      error: `SIGNAL_NOT_SUPPORTED: signal ${signal} is not supported (use SIGTERM or SIGKILL)`,
    };
  }

  const registry = loadRegistry(dataDir);
  const entry = registry[id];
  if (!entry) {
    return { ok: false, error: `PROCESS_NOT_FOUND: process ${id} not found` };
  }

  if (entry.status !== 'running') {
    return {
      ok: true,
      stopped: false,
      ...(entry.exitCode !== undefined && { exit_code: entry.exitCode }),
    };
  }

  try {
    process.kill(entry.pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      await updateEntry(dataDir, id, { status: 'orphan' });
      return { ok: true, stopped: false };
    }
    return {
      ok: false,
      error: `SIGNAL_FAILED: could not send ${signal}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // For SIGTERM, wait up to 5s for graceful exit then escalate to SIGKILL.
  if (signal === 'SIGTERM') {
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
      if (!isAlive(entry.pid)) break;
    }
    if (isAlive(entry.pid)) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // ESRCH means it exited just before SIGKILL — fine
      }
    }
  }

  // Read exit_code if the spawn exit handler already recorded it.
  const finalEntry = loadRegistry(dataDir)[id];
  const exitCode = finalEntry?.exitCode;
  await updateEntry(dataDir, id, { status: 'killed' });
  return { ok: true, stopped: true, ...(exitCode !== undefined && { exit_code: exitCode }) };
}
