// ethos perf — show the slowest completed spans in observability.db
//
// Usage: ethos perf [--slowest N] [--kind <span-kind>]
//
// Defaults: top 20 slowest completed spans.
// Filters:  --kind tool_call|llm_call|hook|mcp_call
//           --slowest N   (default: 20)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import type { Span } from '@ethosagent/types';
import { ethosDir } from '../config';
import { writeJson } from '../json-output';

export async function runPerf(argv: string[]): Promise<void> {
  let slowest = 20;
  let kindFilter: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--slowest' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n > 0) slowest = n;
      i++;
    } else if (arg === '--kind' && argv[i + 1]) {
      kindFilter = argv[i + 1];
      i++;
    }
  }

  const dbPath = join(ethosDir(), 'observability.db');
  if (!existsSync(dbPath)) {
    console.error('No observability.db found. Run ethos chat first to generate data.');
    process.exit(1);
  }

  const store = new SQLiteObservabilityStore(dbPath);
  // Fetch a large batch of recent traces, then collect spans from each.
  // For a perf command we need the slowest spans across all traces.
  // We use getRecentTraces then getSpans — but that's O(traces * spans).
  // Instead we query all completed spans directly via a dedicated method.
  // SQLiteObservabilityStore doesn't expose a raw span query, so we use
  // the store's getSpans per trace — but that's inefficient for many traces.
  //
  // For Wave A, we access the store's underlying DB via the store's public API.
  // We fetch the most recent traces (large limit) and collect their spans.
  const traces = store.getRecentTraces(200);
  const allSpans: Span[] = [];
  for (const trace of traces) {
    const spans = store.getSpans(trace.traceId);
    for (const span of spans) {
      if (span.endTs !== undefined) {
        if (!kindFilter || span.kind === kindFilter) {
          allSpans.push(span);
        }
      }
    }
  }
  store.close();

  if (allSpans.length === 0) {
    console.log('No completed spans found.');
    return;
  }

  // Sort by duration descending
  allSpans.sort((a, b) => {
    const durA = (a.endTs ?? 0) - a.startTs;
    const durB = (b.endTs ?? 0) - b.startTs;
    return durB - durA;
  });

  const top = allSpans.slice(0, slowest);

  if (argv.includes('--json')) {
    const spans = top.map((span, i) => ({
      rank: i + 1,
      name: span.name,
      kind: span.kind,
      durationMs: (span.endTs ?? 0) - span.startTs,
      traceId: span.traceId,
    }));
    writeJson(spans);
    return;
  }

  console.log('Slowest spans');
  console.log('──────────────────────────────────────────────────────');

  for (let i = 0; i < top.length; i++) {
    const span = top[i];
    if (!span) continue;
    const durationMs = (span.endTs ?? 0) - span.startTs;
    const num = String(i + 1).padEnd(3);
    const name = span.name.padEnd(25);
    const kind = span.kind.padEnd(12);
    const ms = `${durationMs.toLocaleString()} ms`.padStart(12);
    const traceShort = span.traceId.slice(0, 8);
    console.log(`${num} ${name} ${kind} ${ms}   ${traceShort}...`);
  }
}
