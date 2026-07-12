import { ethosDir } from '@ethosagent/config';
import {
  listProcesses,
  type ProcessListItem,
  readProcessLogs,
  STOP_SUPPORTED_SIGNALS,
  type StopSignal,
  stopProcess,
} from '@ethosagent/tools-process';

// `ethos process` — CLI mirror of the `process_*` tool family. It drives the
// same registry helpers the tools call (listProcesses / readProcessLogs /
// stopProcess from @ethosagent/tools-process), so the output shape and the
// liveness-check / orphan-marking / stale-reap / SIGTERM-escalation behaviour
// are identical to what the agent sees inside `ethos chat`.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function statusColor(status: ProcessListItem['status']): string {
  switch (status) {
    case 'running':
      return c.green;
    case 'exited':
      return c.dim;
    case 'killed':
      return c.yellow;
    default:
      return c.red;
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runProcessList(dataDir: string, args: string[]): Promise<void> {
  const items = await listProcesses(dataDir);

  if (args.includes('--json')) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log(
      `${c.dim}No tracked processes. Start one with the 'process_start' tool inside 'ethos chat'.${c.reset}`,
    );
    return;
  }

  console.log(`\n${c.bold}Processes:${c.reset}\n`);
  console.log(
    `  ${'ID'.padEnd(38)}${'Name'.padEnd(24)}${'PID'.padEnd(10)}${'Status'.padEnd(10)}Duration`,
  );
  console.log(`  ${'-'.repeat(94)}`);
  for (const p of items) {
    // padEnd on the colored string would count the escape codes; pad the
    // raw status text first, then colorize the whole padded cell.
    const statusCell = `${statusColor(p.status)}${p.status.padEnd(10)}${c.reset}`;
    console.log(
      `  ${p.id.padEnd(38)}${p.name.slice(0, 22).padEnd(24)}${String(p.pid).padEnd(10)}${statusCell}${formatDuration(p.duration_ms)}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

function parseLogFlags(args: string[]): {
  id: string | undefined;
  lines: number | undefined;
  stream: 'stdout' | 'stderr' | 'both' | undefined;
} {
  let id: string | undefined;
  let lines: number | undefined;
  let stream: 'stdout' | 'stderr' | 'both' | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lines') {
      const raw = args[i + 1];
      const n = raw ? Number(raw) : Number.NaN;
      if (!Number.isInteger(n) || n <= 0) {
        console.error('Usage: ethos process logs <id> [--lines N] [--stream stdout|stderr|both]');
        process.exit(1);
      }
      lines = n;
      i++;
    } else if (a === '--stream') {
      const raw = args[i + 1];
      if (raw !== 'stdout' && raw !== 'stderr' && raw !== 'both') {
        console.error('Usage: ethos process logs <id> [--lines N] [--stream stdout|stderr|both]');
        process.exit(1);
      }
      stream = raw;
      i++;
    } else if (a && !a.startsWith('--') && id === undefined) {
      id = a;
    }
  }
  return { id, lines, stream };
}

async function runProcessLogs(dataDir: string, args: string[]): Promise<void> {
  const { id, lines, stream } = parseLogFlags(args);
  if (!id) {
    console.error('Usage: ethos process logs <id> [--lines N] [--stream stdout|stderr|both]');
    process.exit(1);
  }

  const result = await readProcessLogs(dataDir, id, { lines, stream });
  if (!result.ok) {
    console.error(`${c.red}${result.error}${c.reset}`);
    process.exit(1);
  }

  if (result.lines.length === 0) {
    console.log(`${c.dim}(no output)${c.reset}`);
    return;
  }
  console.log(result.lines.join('\n'));
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

const STOP_USAGE = 'Usage: ethos process stop <id> [--signal SIGTERM|SIGKILL]';

function parseStopFlags(args: string[]): { id: string | undefined; signal: StopSignal } {
  let id: string | undefined;
  let signal: StopSignal = 'SIGTERM';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--signal') {
      const raw = args[i + 1];
      if (raw === undefined || !STOP_SUPPORTED_SIGNALS.includes(raw as StopSignal)) {
        console.error(STOP_USAGE);
        process.exit(1);
      }
      signal = raw as StopSignal;
      i++;
    } else if (a && !a.startsWith('--') && id === undefined) {
      id = a;
    }
  }
  return { id, signal };
}

async function runProcessStop(dataDir: string, args: string[]): Promise<void> {
  const { id, signal } = parseStopFlags(args);
  if (!id) {
    console.error(STOP_USAGE);
    process.exit(1);
  }

  const result = await stopProcess(dataDir, id, signal);
  if (!result.ok) {
    console.error(`${c.red}${result.error}${c.reset}`);
    process.exit(1);
  }

  if (result.stopped) {
    const code = result.exit_code !== undefined ? ` (exit code ${result.exit_code})` : '';
    console.log(`${c.green}Stopped process ${id}${c.reset}${code}`);
  } else {
    const code = result.exit_code !== undefined ? ` (exit code ${result.exit_code})` : '';
    console.log(`${c.dim}Process ${id} was not running${code}.${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runProcessCommand(
  sub: string,
  args: string[],
  dataDir: string = ethosDir(),
): Promise<void> {
  switch (sub) {
    case 'list':
    case '':
      await runProcessList(dataDir, args);
      break;
    case 'logs':
      await runProcessLogs(dataDir, args);
      break;
    case 'stop':
      await runProcessStop(dataDir, args);
      break;
    default:
      console.log(
        `${c.cyan}Usage:${c.reset} ethos process [list [--json] | logs <id> [--lines N] [--stream stdout|stderr|both] | stop <id> [--signal SIGTERM|SIGKILL]]`,
      );
  }
}
