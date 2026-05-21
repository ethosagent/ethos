import { join } from 'node:path';
import { stripAnsiEscapes } from '@ethosagent/core';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import type { ObsEvent } from '@ethosagent/types';
import { ethosDir } from '../config';
import { writeJson } from '../json-output';

// ethos errors [--recent [N]] [--since <duration>] [--code <code>]

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function obsDbPath(): string {
  return join(ethosDir(), 'observability.db');
}

function openStore(): SQLiteObservabilityStore {
  return new SQLiteObservabilityStore(obsDbPath());
}

/** Parse a human duration like 1h, 30m, 7d into milliseconds. */
function parseDuration(s: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const mul = multipliers[unit ?? ''];
  return mul !== undefined ? n * mul : undefined;
}

function formatEvent(e: ObsEvent): void {
  const ts = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
  const sev =
    e.severity === 'critical'
      ? `${c.red}${c.bold}critical${c.reset}`
      : `${c.red}${e.severity}${c.reset}`;
  const codeStr = e.code ? `  ${c.cyan}${stripAnsiEscapes(e.code)}${c.reset}` : '';
  const traceRef = e.traceId ? `  ${c.dim}[${e.traceId.slice(0, 8)}]${c.reset}` : '';
  console.log(`  ${ts}  ${sev}${codeStr}${traceRef}`);
  if (e.cause) {
    console.log(`    ${c.dim}cause: ${stripAnsiEscapes(e.cause)}${c.reset}`);
  }
}

interface Flags {
  recent: number;
  since?: number;
  code?: string;
}

function parseFlags(args: string[]): Flags {
  let recent = 20;
  let since: number | undefined;
  let code: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--recent') {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) recent = Math.floor(n);
      i++;
    } else if (a === '--since') {
      const raw = args[i + 1];
      if (raw) {
        const ms = parseDuration(raw);
        if (ms !== undefined) since = Date.now() - ms;
      }
      i++;
    } else if (a === '--code') {
      code = args[i + 1];
      i++;
    }
  }

  return { recent, since, code };
}

export async function runErrors(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const store = openStore();

  try {
    let events = store.getEvents({ category: 'error', since: flags.since, limit: flags.recent });

    if (flags.code) {
      const needle = flags.code.toUpperCase();
      events = events.filter((e) => (e.code ?? '').toUpperCase() === needle);
    }

    if (args.includes('--json')) {
      const summary: Record<string, number> = {};
      const errors = events.map((e) => {
        const key = e.code ?? '(no code)';
        summary[key] = (summary[key] ?? 0) + 1;
        return {
          timestamp: e.ts,
          severity: e.severity,
          code: e.code ?? null,
          traceId: e.traceId ?? null,
          cause: e.cause ?? null,
        };
      });
      writeJson({ errors, summary });
      return;
    }

    console.log(`\n${c.bold}ethos errors${c.reset}  ${c.dim}${events.length} event(s)${c.reset}\n`);

    if (events.length === 0) {
      console.log(`  ${c.dim}No error events found.${c.reset}\n`);
      return;
    }

    console.log(`  ${'TIMESTAMP'.padEnd(20)} ${'SEVERITY'.padEnd(12)} ${'CODE / TRACE'}`);
    console.log(`  ${'-'.repeat(60)}`);

    for (const e of events) {
      formatEvent(e);
    }
    console.log('');

    // Brief code summary at the bottom.
    const byCodes = new Map<string, number>();
    for (const e of events) {
      const key = e.code ?? '(no code)';
      byCodes.set(key, (byCodes.get(key) ?? 0) + 1);
    }
    if (byCodes.size > 1) {
      console.log(`  ${c.dim}Summary by code:${c.reset}`);
      for (const [code, count] of [...byCodes.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(count).padStart(4)}  ${code}`);
      }
      console.log('');
    }
  } finally {
    store.close();
  }
}
