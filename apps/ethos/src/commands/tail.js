// ethos tail — stream new events from observability.db in real time
//
// Usage: ethos tail [--category <pattern>] [--severity <level>] [--session <id>] [--json]
//
// Polls observability.db every 200ms and prints new events as they arrive.
// Exits on Ctrl-C (SIGINT).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripAnsiEscapes } from '@ethosagent/core';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { ethosDir } from '../config';

function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}
export async function runTail(argv) {
  let categoryFilter;
  let severityFilter;
  let sessionFilter;
  let jsonMode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--category' && argv[i + 1]) {
      categoryFilter = argv[i + 1];
      i++;
    } else if (arg === '--severity' && argv[i + 1]) {
      severityFilter = argv[i + 1];
      i++;
    } else if (arg === '--session' && argv[i + 1]) {
      sessionFilter = argv[i + 1];
      i++;
    } else if (arg === '--json') {
      jsonMode = true;
    }
  }
  const dbPath = join(ethosDir(), 'observability.db');
  if (!existsSync(dbPath)) {
    console.error('No observability.db found. Run ethos chat first to generate data.');
    process.exit(1);
  }
  if (!jsonMode) {
    console.log('Tailing observability events (Ctrl-C to stop)...');
  }
  const store = new SQLiteObservabilityStore(dbPath);
  let lastTs = Date.now();
  let seenIds = new Set();
  const tick = () => {
    // Collect trace IDs for the session filter (if provided)
    let traceIds;
    if (sessionFilter) {
      const traces = store.getRecentTraces(1000);
      traceIds = new Set(traces.filter((t) => t.sessionId === sessionFilter).map((t) => t.traceId));
    }
    const events = store.getEvents({ since: lastTs, limit: 500 });
    // getEvents returns DESC order; reverse to ASC for display
    const asc = events.slice().reverse();
    for (const event of asc) {
      // Advance cursor for every event so the window moves regardless of filters.
      // Without this, heavy unmatched traffic starves the cursor and matched
      // events are replayed forever.
      if (event.ts === lastTs && seenIds.has(event.eventId)) continue;
      if (event.ts > lastTs) {
        lastTs = event.ts;
        seenIds = new Set([event.eventId]);
      } else {
        seenIds.add(event.eventId);
      }
      // Apply filters — skip display only, cursor already advanced above
      if (categoryFilter && !event.category.includes(categoryFilter)) continue;
      if (severityFilter && event.severity !== severityFilter) continue;
      if (traceIds) {
        if (!event.traceId || !traceIds.has(event.traceId)) continue;
      }
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        const time = formatTime(event.ts);
        const code = stripAnsiEscapes(event.code ?? '');
        const cause = stripAnsiEscapes(event.cause ?? '');
        const category = stripAnsiEscapes(event.category);
        process.stdout.write(`${time} [${category}] ${event.severity} ${code} ${cause}\n`);
      }
    }
  };
  const interval = setInterval(tick, 200);
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(interval);
      store.close();
      resolve();
    });
  });
}
