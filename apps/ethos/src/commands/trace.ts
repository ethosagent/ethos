import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import type { Span, Trace } from '@ethosagent/types';

// ethos trace [id] [--session <id>] [--recent [N]] [--slow [N]]

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function obsDbPath(): string {
  return join(ethosDir(), 'observability.db');
}

function openStore(): SQLiteObservabilityStore {
  return new SQLiteObservabilityStore(obsDbPath());
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function formatDuration(startTs: number, endTs?: number): string {
  if (endTs === undefined) return '…';
  const ms = endTs - startTs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusColor(status?: string): string {
  if (!status) return `${c.dim}?${c.reset}`;
  if (status === 'ok') return `${c.green}ok${c.reset}`;
  if (status === 'error') return `${c.red}error${c.reset}`;
  if (status === 'aborted') return `${c.yellow}aborted${c.reset}`;
  if (status === 'blocked') return `${c.yellow}blocked${c.reset}`;
  return status;
}

function printTrace(t: Trace): void {
  const dur = formatDuration(t.startTs, t.endTs);
  const status = statusColor(t.status);
  console.log(
    `  ${c.cyan}${t.traceId.slice(0, 8)}${c.reset}  ` +
      `${t.kind.padEnd(18)} ` +
      `${formatTs(t.startTs)}  ` +
      `${dur.padStart(8)}  ` +
      `${status}` +
      (t.sessionId ? `  ${c.dim}session=${t.sessionId.slice(0, 8)}${c.reset}` : ''),
  );
}

function printSpanTimeline(spans: Span[], traceStart: number): void {
  for (const s of spans) {
    const indent = s.parentSpanId ? '    ' : '  ';
    const dur = formatDuration(s.startTs, s.endTs);
    const offset = s.startTs - traceStart;
    const status = statusColor(s.status);
    console.log(
      `${indent}${c.dim}+${offset}ms${c.reset}  ` +
        `${s.kind.padEnd(12)} ` +
        `${s.name.padEnd(30)} ` +
        `${dur.padStart(8)}  ` +
        status,
    );
  }
}

interface Flags {
  sessionId?: string;
  recent: number;
  slow?: number;
  traceId?: string;
}

function parseFlags(args: string[]): Flags {
  let sessionId: string | undefined;
  let recent = 10;
  let slow: number | undefined;
  let traceId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--session') {
      sessionId = args[i + 1];
      i++;
    } else if (a === '--recent') {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) recent = Math.floor(n);
      i++;
    } else if (a === '--slow') {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) slow = Math.floor(n);
      i++;
    } else if (!a.startsWith('--') && !traceId) {
      traceId = a;
    }
  }

  return { sessionId, recent, slow, traceId };
}

export async function runTrace(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  const store = openStore();
  try {
    if (flags.traceId) {
      // Show single trace with spans.
      const trace = store.getTrace(flags.traceId);
      if (!trace) {
        console.error(`Trace not found: ${flags.traceId}`);
        process.exit(1);
      }
      const spans = store.getSpans(flags.traceId);

      console.log(`\n${c.bold}Trace${c.reset}  ${c.cyan}${trace.traceId}${c.reset}\n`);
      console.log(`  kind:       ${trace.kind}`);
      console.log(`  status:     ${statusColor(trace.status)}`);
      console.log(`  start:      ${formatTs(trace.startTs)}`);
      console.log(`  duration:   ${formatDuration(trace.startTs, trace.endTs)}`);
      if (trace.sessionId) console.log(`  session:    ${trace.sessionId}`);
      if (trace.subjectId) console.log(`  personality: ${trace.subjectId}`);

      if (spans.length > 0) {
        console.log(`\n${c.bold}Spans${c.reset} (${spans.length}):\n`);
        printSpanTimeline(spans, trace.startTs);
      } else {
        console.log(`\n  ${c.dim}No spans recorded.${c.reset}`);
      }
      console.log('');
      return;
    }

    // List mode — recent traces, optionally filtered by session or slow threshold.
    const traces = store.getRecentTraces(200);

    let filtered = traces;
    if (flags.sessionId) {
      filtered = filtered.filter((t) => t.sessionId === flags.sessionId);
    }
    if (flags.slow !== undefined) {
      const thresholdMs = flags.slow;
      filtered = filtered.filter((t) => {
        if (t.endTs === undefined) return false;
        return t.endTs - t.startTs >= thresholdMs;
      });
    }

    const display = filtered.slice(0, flags.recent);

    console.log(
      `\n${c.bold}ethos trace${c.reset}  ${c.dim}${display.length} of ${filtered.length}${c.reset}\n`,
    );

    if (display.length === 0) {
      console.log(`  ${c.dim}No traces found.${c.reset}\n`);
      return;
    }

    console.log(
      `  ${'ID'.padEnd(10)} ${'KIND'.padEnd(18)} ${'STARTED'.padEnd(20)} ${'DUR'.padStart(8)}  STATUS`,
    );
    console.log(`  ${'-'.repeat(72)}`);

    for (const t of display) {
      printTrace(t);
    }
    console.log('');
  } finally {
    store.close();
  }
}
