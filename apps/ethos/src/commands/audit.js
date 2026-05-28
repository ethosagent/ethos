import { join } from 'node:path';
import { stripAnsiEscapes } from '@ethosagent/core';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { ethosDir } from '../config';

// ethos audit [--since <duration>] [--category <pattern>] [transitions|decisions]
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
function obsDbPath() {
  return join(ethosDir(), 'observability.db');
}
function openStore() {
  return new SQLiteObservabilityStore(obsDbPath());
}
/** Parse a human duration like 1h, 30m, 7d into milliseconds. */
function parseDuration(s) {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const mul = multipliers[unit ?? ''];
  return mul !== undefined ? n * mul : undefined;
}
function severityColor(severity) {
  if (severity === 'info') return `${c.green}info${c.reset}`;
  if (severity === 'warn') return `${c.yellow}warn${c.reset}`;
  if (severity === 'error') return `${c.red}error${c.reset}`;
  if (severity === 'critical') return `${c.red}${c.bold}critical${c.reset}`;
  return severity;
}
function formatEvent(e) {
  const ts = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
  const sev = severityColor(e.severity);
  const traceRef = e.traceId ? `${c.dim}[${e.traceId.slice(0, 8)}]${c.reset} ` : '';
  const codeStr = e.code ? ` ${c.cyan}${stripAnsiEscapes(e.code)}${c.reset}` : '';
  const causeStr = e.cause ? `  ${c.dim}→ ${stripAnsiEscapes(e.cause)}${c.reset}` : '';
  console.log(`  ${ts}  ${sev.padEnd(18)} ${e.category}${codeStr}  ${traceRef}${causeStr}`);
}
function parseFlags(args) {
  let since;
  let category;
  let limit = 50;
  let subcommand;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--since') {
      const raw = args[i + 1];
      if (raw) {
        const ms = parseDuration(raw);
        if (ms !== undefined) since = Date.now() - ms;
      }
      i++;
    } else if (a === '--category') {
      category = args[i + 1];
      i++;
    } else if (a === '--limit') {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
      i++;
    } else if (!a.startsWith('--')) {
      subcommand = a;
    }
  }
  return { since, category, limit, subcommand };
}
export async function runAudit(args) {
  const flags = parseFlags(args);
  const store = openStore();
  try {
    let categoryFilter = flags.category;
    let title = 'audit events';
    if (flags.subcommand === 'transitions') {
      categoryFilter = 'audit.transition';
      title = 'audit — transitions';
    } else if (flags.subcommand === 'decisions') {
      title = 'audit — decisions';
    }
    let events;
    if (flags.subcommand === 'decisions') {
      // Merge approval + block + watcher events.
      const categories = ['audit.approval', 'audit.block', 'audit.watcher'];
      const all = [];
      for (const cat of categories) {
        all.push(...store.getEvents({ category: cat, since: flags.since, limit: flags.limit }));
      }
      // Sort newest first and cap.
      all.sort((a, b) => b.ts - a.ts);
      events = all.slice(0, flags.limit);
    } else {
      events = store.getEvents({
        category: categoryFilter,
        since: flags.since,
        limit: flags.limit,
      });
    }
    // Filter by category pattern if a glob-style pattern was provided alongside a subcommand.
    if (flags.category && flags.subcommand) {
      const pat = flags.category.toLowerCase();
      events = events.filter((e) => e.category.toLowerCase().includes(pat));
    }
    console.log(
      `\n${c.bold}ethos audit${c.reset}  ${c.dim}${title} (${events.length})${c.reset}\n`,
    );
    if (events.length === 0) {
      console.log(`  ${c.dim}No audit events found.${c.reset}\n`);
      return;
    }
    console.log(`  ${'TIMESTAMP'.padEnd(20)} ${'SEVERITY'.padEnd(18)} ${'CATEGORY / CODE'}`);
    console.log(`  ${'-'.repeat(72)}`);
    for (const e of events) {
      formatEvent(e);
    }
    console.log('');
  } finally {
    store.close();
  }
}
