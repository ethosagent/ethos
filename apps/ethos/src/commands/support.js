// ethos support bundle [--since <ts>] [--until <ts>] [--session <id>]
//                      [--include-bodies] [--include-memory] [--anonymize]
// ethos support inspect <bundle.tar.gz> [--json]
//
// Bundle: creates a privacy-conscious support tarball in the current directory.
// Inspect: reads a bundle and renders a timeline + diagnosis.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { stripAnsiEscapes } from '@ethosagent/core';
import { createTarGz, readTarGz, SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { EthosError } from '@ethosagent/types';
import { ethosDir, readRawConfig } from '../config';
import { getStorage } from '../wiring';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function fmtTs(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}
function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
function fmtDuration(startTs, endTs) {
  if (endTs === undefined) return '…';
  const ms = endTs - startTs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
/** Parse a human timestamp string to epoch-ms. Supports:
 *  - ISO format: "2026-05-04T14:00:00" or "2026-05-04 14:00:00"
 *  - HH:MM or HH:MM:SS → today's date at that time
 *  - Nd / Nh / Nm → that duration before now
 */
function parseTimestamp(s) {
  // Relative duration
  const rel = s.match(/^(\d+)(d|h|m)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === 'd' ? n * 86_400_000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
    return Date.now() - ms;
  }
  // HH:MM or HH:MM:SS — today
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const parts = s.split(':').map(Number);
    const d = new Date();
    d.setHours(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, 0);
    return d.getTime();
  }
  // ISO / date string
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return parsed;
  throw new EthosError({
    code: 'INVALID_INPUT',
    cause: `Cannot parse timestamp: "${s}"`,
    action: 'Use ISO format (2026-05-04T14:00), HH:MM, or relative (1d, 2h, 30m).',
  });
}
// ---------------------------------------------------------------------------
// Privacy: strip secrets from config objects before bundling
// ---------------------------------------------------------------------------
const SECRET_KEY_RE = /key|token|secret|password/i;
function stripSecrets(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => stripSecrets(v));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : stripSecrets(v);
  }
  return out;
}
// ---------------------------------------------------------------------------
// Anonymize: replace identifying strings in bundle content
// ---------------------------------------------------------------------------
function buildAnonymizer(cwd) {
  const home = homedir();
  const host = hostname();
  const user = home.split('/').pop() ?? home.split('\\').pop() ?? 'user';
  const replacements = [
    [new RegExp(home.replace(/[/\\]/g, '[/\\\\]'), 'g'), '<home>'],
    [new RegExp(cwd.replace(/[/\\]/g, '[/\\\\]'), 'g'), '<cwd>'],
    [new RegExp(host, 'gi'), '<hostname>'],
    [new RegExp(`\\b${user}\\b`, 'g'), '<user>'],
  ];
  return (s) => {
    let out = s;
    for (const [re, replacement] of replacements) out = out.replace(re, replacement);
    return out;
  };
}
function parseBundleFlags(argv) {
  const flags = { includeBodies: false, includeMemory: false, anonymize: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--since' && argv[i + 1]) {
      flags.since = parseTimestamp(argv[i + 1] ?? '');
      i++;
    } else if (a === '--until' && argv[i + 1]) {
      flags.until = parseTimestamp(argv[i + 1] ?? '');
      i++;
    } else if ((a === '--session' || a === '-s') && argv[i + 1]) {
      flags.session = argv[i + 1];
      i++;
    } else if (a === '--include-bodies') {
      flags.includeBodies = true;
    } else if (a === '--include-memory') {
      flags.includeMemory = true;
    } else if (a === '--anonymize') {
      flags.anonymize = true;
    }
  }
  return flags;
}
export async function runBundle(argv) {
  const flags = parseBundleFlags(argv);
  const dbPath = join(ethosDir(), 'observability.db');
  if (!existsSync(dbPath)) {
    console.log('No observability.db found. Run ethos chat first to generate data.');
    return;
  }
  console.log('Generating support bundle...\n');
  const anon = flags.anonymize ? buildAnonymizer(process.cwd()) : (s) => s;
  const store = new SQLiteObservabilityStore(dbPath);
  try {
    // Collect traces in the requested window
    const traces = store.getTraces({
      since: flags.since,
      until: flags.until,
      sessionId: flags.session,
      limit: 2000,
    });
    const traceIds = traces.map((t) => t.traceId);
    const spans = store.getSpansByTraceIds(traceIds);
    const events = store.getEventsByTraceIds(traceIds);
    // Also include time-range events not tied to traces (e.g. system events)
    const looseEvents =
      flags.since !== undefined
        ? store.getEvents({ since: flags.since, limit: 500 }).filter((e) => !e.traceId)
        : [];
    const allEvents = [...events, ...looseEvents];
    const snapshotIds = [...new Set(traces.map((t) => t.snapshotId).filter((id) => id != null))];
    const snapshots = store.getSnapshotsByIds(snapshotIds);
    // Load personality configs (secrets stripped)
    const storage = getStorage();
    const config = await readRawConfig(storage);
    const safeConfig = config ? stripSecrets({ ...config }) : null;
    // Memory files (opt-in only)
    let memoryContent = null;
    if (flags.includeMemory) {
      const parts = [];
      const memContent = await storage.read(join(ethosDir(), 'MEMORY.md'));
      if (memContent !== null) parts.push(`# MEMORY.md\n${memContent}`);
      const userContent = await storage.read(join(ethosDir(), 'USER.md'));
      if (userContent !== null) parts.push(`# USER.md\n${userContent}`);
      if (parts.length > 0) memoryContent = parts.join('\n\n');
    }
    // Count span kinds
    const toolSpans = spans.filter((s) => s.kind === 'tool_call');
    const llmSpans = spans.filter((s) => s.kind === 'llm_call');
    // Count event types
    const errorEvents = allEvents.filter((e) => e.category === 'error');
    const auditEvents = allEvents.filter((e) => e.category.startsWith('audit.'));
    // Build system metadata
    const bundleId = randomBytes(3).toString('hex');
    const systemInfo = {
      bundleId,
      generatedAt: new Date().toISOString(),
      ethosVersion: process.env.ETHOS_VERSION ?? 'dev',
      nodeVersion: process.version,
      platform: `${process.platform} / Node ${process.version}`,
      filter: {
        since: flags.since ? new Date(flags.since).toISOString() : null,
        until: flags.until ? new Date(flags.until).toISOString() : null,
        session: flags.session ?? null,
      },
    };
    // Assemble bundle files
    const toJsonl = (arr) =>
      Buffer.from(arr.map((r) => anon(JSON.stringify(r))).join('\n'), 'utf8');
    const files = new Map();
    files.set('system.json', Buffer.from(anon(JSON.stringify(systemInfo, null, 2)), 'utf8'));
    files.set('traces.jsonl', toJsonl(traces));
    files.set('spans.jsonl', toJsonl(spans));
    files.set('events.jsonl', toJsonl(allEvents));
    files.set('snapshots.jsonl', toJsonl(snapshots));
    if (safeConfig) {
      files.set('config.json', Buffer.from(anon(JSON.stringify(safeConfig, null, 2)), 'utf8'));
    }
    if (memoryContent) {
      files.set('memory.md', Buffer.from(anon(memoryContent), 'utf8'));
    }
    // Blobs (opt-in)
    if (flags.includeBodies) {
      const blobsDir = join(ethosDir(), 'blobs');
      const bodyRefs = spans.map((s) => s.attrs?.body_ref).filter((r) => r != null);
      if (bodyRefs.length > 0) {
        for (const ref of bodyRefs) {
          const blobPath = join(blobsDir, ref.slice(0, 2), `${ref}.gz`);
          if (existsSync(blobPath)) {
            files.set(`blobs/${ref}`, readFileSync(blobPath));
          }
        }
      }
    }
    const tarGz = createTarGz(files);
    const outputName = `support-bundle-${bundleId}.tar.gz`;
    writeFileSync(outputName, tarGz);
    const sizeKb = Math.round(tarGz.length / 1024);
    // Audit trail: record that a bundle was generated.
    store.insertTrace({
      traceId: bundleId,
      kind: 'support.bundle',
      startTs: Date.now(),
      endTs: Date.now(),
      status: 'ok',
      attrs: { outputFile: outputName, traces: traceIds.length, spans: spans.length },
    });
    // Print manifest
    if (traces.length > 0) {
      const kindCounts = traces.reduce((acc, t) => {
        acc[t.kind] = (acc[t.kind] ?? 0) + 1;
        return acc;
      }, {});
      const kindSummary = Object.entries(kindCounts)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      console.log(`Contents:`);
      console.log(`  ✓ ${traces.length} trace(s)         (${kindSummary})`);
    } else {
      console.log('Contents:');
      console.log('  ✓ 0 traces          (no data in requested window)');
    }
    console.log(`  ✓ ${toolSpans.length} tool call span(s)`);
    console.log(`  ✓ ${llmSpans.length} LLM call span(s)`);
    console.log(
      `  ✓ ${allEvents.length} event(s)          (${errorEvents.length} error, ${auditEvents.length} audit)`,
    );
    console.log(`  ✓ ${snapshots.length} policy snapshot(s)`);
    console.log(`  ✓ Ethos version + OS + Node version`);
    if (safeConfig) console.log(`  ✓ Config (sensitive fields removed)`);
    console.log('\nNOT included by default:');
    if (!flags.includeBodies)
      console.log('  ✗ Tool response bodies  (run again with --include-bodies)');
    if (!flags.includeMemory)
      console.log('  ✗ MEMORY.md / USER.md   (run again with --include-memory)');
    console.log('  ✗ API keys / secrets    (always excluded)');
    console.log(`\nOutput: ${outputName} (${sizeKb} KB)`);
    if (flags.anonymize) console.log('  (paths and hostnames anonymized)');
  } finally {
    store.close();
  }
}
function parseJsonlBuf(buf) {
  if (!buf || buf.length === 0) return [];
  return buf
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function loadBundle(bundlePath) {
  const raw = readFileSync(bundlePath);
  const files = readTarGz(raw);
  const sysRaw = files.get('system.json');
  const system = sysRaw ? JSON.parse(sysRaw.toString('utf8')) : {};
  const traces = parseJsonlBuf(files.get('traces.jsonl'));
  const spans = parseJsonlBuf(files.get('spans.jsonl'));
  const events = parseJsonlBuf(files.get('events.jsonl'));
  const snapshots = parseJsonlBuf(files.get('snapshots.jsonl'));
  return { system, traces, spans, events, snapshots };
}
function severityIcon(severity) {
  if (severity === 'critical') return '✗✗';
  if (severity === 'error') return '✗';
  if (severity === 'warn') return '⚠';
  return '·';
}
export function diagnoseBundleLines(traces, spans, events) {
  const lines = [];
  const transitions = events
    .filter((e) => e.category === 'audit.transition')
    .sort((a, b) => a.ts - b.ts);
  const blocks = events.filter((e) => e.category === 'audit.block');
  const errors = events.filter((e) => e.category === 'error');
  const autoApprovals = events.filter(
    (e) => e.category === 'audit.approval' && e.details?.auto === true,
  );
  if (transitions.length > 0) {
    lines.push(`▸ ${transitions.length} policy transition(s) detected in window`);
    for (const t of transitions) {
      const from = t.details?.from ?? '?';
      const to = t.details?.to ?? '?';
      lines.push(`  At ${fmtTime(t.ts)}: ${String(from)} → ${String(to)}`);
    }
  }
  if (blocks.length > 0) {
    lines.push(`▸ ${blocks.length} tool call(s) blocked by safety layer`);
    for (const b of blocks.slice(0, 3)) {
      lines.push(`  ${fmtTime(b.ts)}  ${stripAnsiEscapes(b.code ?? b.cause ?? 'blocked')}`);
    }
  }
  if (autoApprovals.length > 0) {
    lines.push(`▸ ${autoApprovals.length} auto-approval(s) bypassed user confirmation`);
  }
  if (errors.length > 0) {
    lines.push(`▸ ${errors.length} error event(s) in window`);
    for (const e of errors.slice(0, 3)) {
      const code = stripAnsiEscapes(e.code ?? 'error');
      const cause = stripAnsiEscapes(e.cause ?? '');
      lines.push(`  ${fmtTime(e.ts)}  [${code}] ${cause}`);
    }
  }
  const toolSpans = spans.filter((s) => s.kind === 'tool_call');
  if (toolSpans.length > 0) {
    const slowest = [...toolSpans].sort(
      (a, b) => (b.endTs ?? b.startTs) - b.startTs - ((a.endTs ?? a.startTs) - a.startTs),
    )[0];
    if (slowest?.endTs) {
      const dur = slowest.endTs - slowest.startTs;
      if (dur > 5000) {
        lines.push(`▸ Slowest tool call: ${slowest.name} took ${(dur / 1000).toFixed(1)}s`);
      }
    }
  }
  if (lines.length === 0) {
    lines.push('▸ No anomalies detected in this window');
    if (traces.length === 0) lines.push('  (bundle contains no traces — window may be empty)');
  }
  return lines;
}
export async function runInspect(argv) {
  let bundlePath;
  let jsonMode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--json') {
      jsonMode = true;
    } else if (!a.startsWith('-')) {
      bundlePath = a;
    }
  }
  if (!bundlePath) {
    console.log('Usage: ethos support inspect <bundle.tar.gz> [--json]');
    return;
  }
  if (!existsSync(bundlePath)) {
    console.error(`Bundle not found: ${bundlePath}`);
    process.exit(1);
  }
  let bundle;
  try {
    bundle = loadBundle(bundlePath);
  } catch (e) {
    console.error(`Failed to read bundle: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (jsonMode) {
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }
  const { system, traces, spans, events, snapshots } = bundle;
  const bundleId = system.bundleId ?? 'unknown';
  const version = system.ethosVersion ?? 'unknown';
  const platform = system.platform ?? 'unknown';
  const filter = system.filter;
  // Time range
  const allTs = [...traces.map((t) => t.startTs), ...events.map((e) => e.ts)];
  const rangeStart = allTs.length > 0 ? Math.min(...allTs) : 0;
  const rangeEnd = allTs.length > 0 ? Math.max(...allTs) : 0;
  const rangeStr = rangeStart > 0 ? `${fmtTs(rangeStart)} → ${fmtTs(rangeEnd)}` : 'no data';
  const bundleSize = statSync(bundlePath).size;
  const sizeKb = Math.round(bundleSize / 1024);
  const hr = '═'.repeat(72);
  console.log(`\n${hr}`);
  console.log(`  SUPPORT BUNDLE  ·  ${bundleId}  ·  ${rangeStr}  ·  ${sizeKb} KB`);
  console.log(`${hr}\n`);
  // ── CONTEXT ──────────────────────────────────────────────────────────────
  console.log('CONTEXT');
  console.log(`  Ethos version    ${version}`);
  console.log(`  Platform         ${platform}`);
  const personalities = [...new Set(traces.map((t) => t.subjectId).filter(Boolean))];
  if (personalities.length > 0) {
    console.log(`  Personality      ${personalities.join(' → ')}`);
  }
  if (filter?.session) {
    console.log(`  Session          ${filter.session}`);
  }
  if (filter?.since ?? filter?.until) {
    const fromStr = filter.since ?? '(beginning)';
    const toStr = filter.until ?? '(end)';
    console.log(`  Window           ${fromStr} → ${toStr}`);
  }
  console.log();
  // ── POLICY TRANSITIONS ───────────────────────────────────────────────────
  const transitions = events
    .filter((e) => e.category === 'audit.transition')
    .sort((a, b) => a.ts - b.ts);
  if (transitions.length > 0) {
    console.log(`POLICY TRANSITIONS IN WINDOW (${transitions.length})`);
    for (const t of transitions) {
      const from = t.details?.from ?? '?';
      const to = t.details?.to ?? '?';
      console.log(`  ${fmtTs(t.ts)}  ${String(from)} → ${String(to)}`);
      if (t.details?.diff && typeof t.details.diff === 'object') {
        const diff = t.details.diff;
        for (const [field, change] of Object.entries(diff)) {
          const c = change;
          if (c) console.log(`    ⚠ ${field}: ${String(c.from)} → ${String(c.to)}`);
        }
      }
    }
    console.log();
  }
  // ── TOOL CALLS ───────────────────────────────────────────────────────────
  const toolSpans = spans
    .filter((s) => s.kind === 'tool_call')
    .sort((a, b) => a.startTs - b.startTs);
  if (toolSpans.length > 0) {
    const shown = toolSpans.slice(0, 20);
    const omitted = toolSpans.length - shown.length;
    console.log(
      `TOOL CALLS (${toolSpans.length} total${omitted > 0 ? ` — showing first 20` : ''})`,
    );
    for (const s of shown) {
      const dur = fmtDuration(s.startTs, s.endTs);
      const status =
        s.status === 'ok' ? '✓' : s.status === 'blocked' ? '✗ blocked' : (s.status ?? '?');
      const argsPreview = s.attrs?.args ? ` '${JSON.stringify(s.attrs.args).slice(0, 40)}'` : '';
      console.log(
        `  ${fmtTime(s.startTs)}  ${s.name.padEnd(20)}${argsPreview.padEnd(44)}  ${status}  ${dur}`,
      );
    }
    if (omitted > 0) console.log(`  … ${omitted} more tool calls`);
    console.log();
  }
  // ── EVENTS OF NOTE ────────────────────────────────────────────────────────
  const notableCategories = new Set(['error', 'audit.block', 'audit.watcher', 'audit.approval']);
  const notable = events
    .filter((e) => notableCategories.has(e.category))
    .sort((a, b) => a.ts - b.ts);
  if (notable.length > 0) {
    console.log('EVENTS OF NOTE');
    for (const e of notable.slice(0, 15)) {
      const icon = severityIcon(e.severity);
      const detail = stripAnsiEscapes(e.cause ?? e.code ?? '');
      console.log(`  ${fmtTs(e.ts)}  ${icon}  ${e.category.padEnd(20)}  ${detail.slice(0, 60)}`);
    }
    if (notable.length > 15) console.log(`  … ${notable.length - 15} more events`);
    console.log();
  }
  // ── POLICY SNAPSHOTS ──────────────────────────────────────────────────────
  if (snapshots.length > 0) {
    console.log(`POLICY SNAPSHOTS (${snapshots.length})`);
    for (const s of snapshots) {
      console.log(`  ${s.personalityId.padEnd(24)} sha:${s.snapshotId.slice(0, 8)}`);
    }
    console.log();
  }
  // ── DIAGNOSIS ────────────────────────────────────────────────────────────
  console.log('DIAGNOSIS');
  const diagLines = diagnoseBundleLines(traces, spans, events);
  for (const line of diagLines) console.log(`  ${line}`);
  console.log();
  console.log(hr);
  console.log();
}
export async function runSupport(sub, argv) {
  if (sub === 'bundle') {
    await runBundle(argv);
    return;
  }
  if (sub === 'inspect') {
    await runInspect(argv);
    return;
  }
  console.log(
    'Usage: ethos support [bundle [--since <ts>] [--until <ts>] [--session <id>] [--include-bodies] [--include-memory] [--anonymize] | inspect <bundle.tar.gz> [--json]]',
  );
}
