import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';
import {
  isAlive,
  loadRegistry,
  type ProcessEntry,
  reapStale,
  saveRegistry,
  updateEntry,
} from './registry';
import { spawnDetached } from './spawn';

const MAX_CONCURRENT = 8;
const DEFAULT_LOG_LINES = 200;
const DEFAULT_WAIT_TIMEOUT_S = 30;
const WAIT_POLL_MS = 200;
const SIGTERM_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLastLines(path: string, n: number, prefix: string): string[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  // remove trailing empty line that split creates
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).map((l) => `[${prefix}] ${l}`);
}

function runningCount(entries: ProcessEntry[]): number {
  return entries.filter((e) => e.status === 'running').length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// process_start
// ---------------------------------------------------------------------------

function makeProcessStart(dataDir: string): Tool {
  return {
    name: 'process_start',
    description: 'Start a long-running process in the background. Returns an id for tracking.',
    toolset: 'process',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory (defaults to ctx.workingDir)' },
        env: {
          type: 'object',
          description: 'Extra environment variables',
          additionalProperties: { type: 'string' },
        },
        name: { type: 'string', description: 'Human-friendly label for this process' },
      },
      required: ['command'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { command, cwd, env, name } = args as {
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        name?: string;
      };

      if (!command) return { ok: false, error: 'command is required', code: 'input_invalid' };

      const registry = loadRegistry(dataDir);
      const entries = Object.values(registry);

      if (runningCount(entries) >= MAX_CONCURRENT) {
        return {
          ok: false,
          error: 'PROCESS_CAP_EXCEEDED: max 8 concurrent processes',
          code: 'execution_failed',
        };
      }

      const id = randomUUID();
      const effectiveCwd = cwd ?? ctx.workingDir;
      const effectiveName = name ?? command.slice(0, 40);
      const startedAt = new Date().toISOString();

      let pid: number;
      try {
        const result = spawnDetached(id, command, effectiveCwd, env, dataDir);
        pid = result.pid;
      } catch (err) {
        return {
          ok: false,
          error: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
          code: 'execution_failed',
        };
      }

      registry[id] = {
        id,
        name: effectiveName,
        pid,
        command,
        cwd: effectiveCwd,
        status: 'running',
        startedAt,
        lastTouchedAt: startedAt,
      };
      saveRegistry(dataDir, registry);

      return {
        ok: true,
        value: JSON.stringify({ id, pid, name: effectiveName, started_at: startedAt }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// process_list
// ---------------------------------------------------------------------------

function makeProcessList(dataDir: string): Tool {
  return {
    name: 'process_list',
    description: 'List all tracked processes with their current status.',
    toolset: 'process',
    schema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      let registry = loadRegistry(dataDir);

      // liveness check and reap
      let dirty = false;
      for (const entry of Object.values(registry)) {
        if (entry.status !== 'running') continue;
        if (!isAlive(entry.pid)) {
          registry[entry.id] = {
            ...entry,
            status: 'orphan',
            lastTouchedAt: new Date().toISOString(),
          };
          dirty = true;
        }
      }

      registry = reapStale(registry);

      if (dirty) saveRegistry(dataDir, registry);

      const now = Date.now();
      const items = Object.values(registry).map((e) => {
        const durationMs = now - new Date(e.startedAt).getTime();
        return {
          id: e.id,
          name: e.name,
          pid: e.pid,
          status: e.status,
          started_at: e.startedAt,
          ...(e.exitCode !== undefined ? { exit_code: e.exitCode } : {}),
          duration_ms: durationMs,
        };
      });

      return { ok: true, value: JSON.stringify(items, null, 2) };
    },
  };
}

// ---------------------------------------------------------------------------
// process_logs
// ---------------------------------------------------------------------------

function makeProcessLogs(dataDir: string): Tool {
  return {
    name: 'process_logs',
    description: 'Return the last N lines from a process log. Interleaves stdout and stderr.',
    toolset: 'process',
    maxResultChars: 40_000,
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id' },
        lines: {
          type: 'number',
          description: `Number of lines to return (default ${DEFAULT_LOG_LINES})`,
        },
        stream: {
          type: 'string',
          enum: ['stdout', 'stderr', 'both'],
          description: 'Which stream to read (default "both")',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id, lines, stream } = args as {
        id: string;
        lines?: number;
        stream?: 'stdout' | 'stderr' | 'both';
      };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      const registry = loadRegistry(dataDir);
      const entry = registry[id];
      if (!entry) {
        return { ok: false, error: `Process ${id} not found`, code: 'execution_failed' };
      }

      const n = lines ?? DEFAULT_LOG_LINES;
      const which = stream ?? 'both';
      const dir = join(dataDir, 'processes', id);

      let combined: string[];
      if (which === 'stdout') {
        combined = readLastLines(join(dir, 'stdout.log'), n, 'stdout');
      } else if (which === 'stderr') {
        combined = readLastLines(join(dir, 'stderr.log'), n, 'stderr');
      } else {
        // interleave: read both full files, combine, take last n
        const out = readLastLines(join(dir, 'stdout.log'), n, 'stdout');
        const err = readLastLines(join(dir, 'stderr.log'), n, 'stderr');
        combined = [...out, ...err].slice(-n);
      }

      if (combined.length === 0) {
        return { ok: true, value: '(no output)' };
      }

      return { ok: true, value: combined.join('\n') };
    },
  };
}

// ---------------------------------------------------------------------------
// process_stop
// ---------------------------------------------------------------------------

function makeProcessStop(dataDir: string): Tool {
  return {
    name: 'process_stop',
    description: 'Send a signal to stop a running process.',
    toolset: 'process',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id' },
        signal: {
          type: 'string',
          enum: ['SIGTERM', 'SIGKILL'],
          description: 'Signal to send (default "SIGTERM")',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id, signal } = args as { id: string; signal?: 'SIGTERM' | 'SIGKILL' };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      const registry = loadRegistry(dataDir);
      const entry = registry[id];
      if (!entry) {
        return { ok: false, error: `Process ${id} not found`, code: 'execution_failed' };
      }

      const sig = signal ?? 'SIGTERM';

      if (entry.status !== 'running') {
        return {
          ok: true,
          value: JSON.stringify({ stopped: false, exit_code: entry.exitCode }),
        };
      }

      try {
        process.kill(entry.pid, sig);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          updateEntry(dataDir, id, { status: 'orphan' });
          return { ok: true, value: JSON.stringify({ stopped: false }) };
        }
        return {
          ok: false,
          error: `Failed to send ${sig}: ${err instanceof Error ? err.message : String(err)}`,
          code: 'execution_failed',
        };
      }

      // For SIGTERM, wait up to 5s for graceful exit then escalate to SIGKILL.
      if (sig === 'SIGTERM') {
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

      // Read exit_code if the spawn exit handler already recorded it
      const finalEntry = loadRegistry(dataDir)[id];
      const exitCode = finalEntry?.exitCode;
      updateEntry(dataDir, id, { status: 'killed' });
      return {
        ok: true,
        value: JSON.stringify({
          stopped: true,
          ...(exitCode !== undefined && { exit_code: exitCode }),
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// process_wait
// ---------------------------------------------------------------------------

function makeProcessWait(dataDir: string): Tool {
  return {
    name: 'process_wait',
    description: 'Wait for a process to exit, up to timeout_s seconds.',
    toolset: 'process',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id' },
        timeout_s: {
          type: 'number',
          description: `Seconds to wait (default ${DEFAULT_WAIT_TIMEOUT_S})`,
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id, timeout_s } = args as { id: string; timeout_s?: number };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      const registry = loadRegistry(dataDir);
      const entry = registry[id];
      if (!entry) {
        return { ok: false, error: `Process ${id} not found`, code: 'execution_failed' };
      }

      if (entry.status !== 'running') {
        return {
          ok: true,
          value: JSON.stringify({ exited: true, exit_code: entry.exitCode }),
        };
      }

      const timeoutMs = (timeout_s ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        await sleep(WAIT_POLL_MS);
        const current = loadRegistry(dataDir)[id];
        if (!current) break;
        if (current.status !== 'running') {
          return {
            ok: true,
            value: JSON.stringify({ exited: true, exit_code: current.exitCode }),
          };
        }
        if (!isAlive(current.pid)) {
          updateEntry(dataDir, id, { status: 'orphan' });
          return { ok: true, value: JSON.stringify({ exited: true }) };
        }
      }

      return { ok: true, value: JSON.stringify({ exited: false }) };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProcessTools(dataDir: string): Tool[] {
  return [
    makeProcessStart(dataDir),
    makeProcessList(dataDir),
    makeProcessLogs(dataDir),
    makeProcessStop(dataDir),
    makeProcessWait(dataDir),
  ];
}
