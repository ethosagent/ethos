// ethos tail — stream new events from observability.db in real time
//
// Usage: ethos tail [--category <pattern>] [--severity <level>] [--session <id>] [--json]
//
// Polls observability.db every 200ms and prints new events as they arrive.
// Exits on Ctrl-C (SIGINT).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { ethosDir } from '../config';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export async function runTail(argv: string[]): Promise<void> {
  let categoryFilter: string | undefined;
  let severityFilter: string | undefined;
  let sessionFilter: string | undefined;
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

  const tick = () => {
    // Collect trace IDs for the session filter (if provided)
    let traceIds: Set<string> | undefined;
    if (sessionFilter) {
      const traces = store.getRecentTraces(1000);
      traceIds = new Set(traces.filter((t) => t.sessionId === sessionFilter).map((t) => t.traceId));
    }

    const events = store.getEvents({ since: lastTs, limit: 500 });
    // getEvents returns DESC order; reverse to ASC for display
    const asc = events.slice().reverse();

    for (const event of asc) {
      if (event.ts <= lastTs) continue;

      // Apply filters
      if (categoryFilter && !event.category.includes(categoryFilter)) continue;
      if (severityFilter && event.severity !== severityFilter) continue;
      if (traceIds && event.traceId && !traceIds.has(event.traceId)) continue;

      lastTs = event.ts;

      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        const time = formatTime(event.ts);
        const code = event.code ?? '';
        const cause = event.cause ?? '';
        process.stdout.write(`${time} [${event.category}] ${event.severity} ${code} ${cause}\n`);
      }
    }
  };

  const interval = setInterval(tick, 200);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(interval);
      store.close();
      resolve();
    });
  });
}
