import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import { ethosDir } from '../config';
// ---------------------------------------------------------------------------
// FW-2 helpers — used by CLI flag parsing in index.ts
// ---------------------------------------------------------------------------
export async function resolveResumeSession(store, target) {
  if (target.type === 'continue') {
    // Scope to CLI sessions so --continue never crosses into gateway/telegram sessions.
    return store.findMostRecent('cli');
  }
  const { query } = target;
  // 1. Exact match on session ID
  const byId = await store.getSession(query);
  if (byId) return byId;
  // 2. Exact match on title (case-insensitive), then fragment match
  const byTitle = await store.findByTitle(query);
  if (byTitle.length === 0) return null;
  if (byTitle.length === 1) return byTitle[0] ?? null;
  // Multiple matches — throw with candidate list so the caller can show them
  const candidates = byTitle.map((s) => `  ${s.id}  ${s.title ?? '(no title)'}`).join('\n');
  throw new EthosError({
    code: 'INVALID_INPUT',
    cause: `Multiple sessions match "${query}":\n${candidates}`,
    action: 'Use --resume <exact-id> to disambiguate.',
  });
}
// ---------------------------------------------------------------------------
// FW-3 helpers — used by sessions command + tests
// ---------------------------------------------------------------------------
export async function listSessions(store, opts) {
  const limit = opts.limit ?? 20;
  // Push keyPrefix into SQL so limit is respected against the filtered set.
  const sessions = await store.listSessions({ limit, keyPrefix: opts.keyPrefix });
  return sessions.map((s) => ({
    id: s.id,
    key: s.key,
    title: s.title,
    messageCount: 0, // populated lazily in CLI rendering if needed
    updatedAt: s.updatedAt,
  }));
}
export async function renameSession(store, sessionId, title) {
  const session = await store.getSession(sessionId);
  if (!session)
    throw new EthosError({
      code: 'SESSION_NOT_FOUND',
      cause: `Session not found: ${sessionId}`,
      action: 'Check the session ID with `ethos sessions list`.',
    });
  await store.updateSession(sessionId, { title });
}
export async function deleteSessionById(store, sessionId) {
  const session = await store.getSession(sessionId);
  if (!session)
    throw new EthosError({
      code: 'SESSION_NOT_FOUND',
      cause: `Session not found: ${sessionId}`,
      action: 'Check the session ID with `ethos sessions list`.',
    });
  await store.deleteSession(sessionId);
}
export async function searchSessions(store, query, opts) {
  const results = await store.search(query, { limit: opts.limit ?? 20 });
  // Deduplicate by sessionId, keep best score per session
  const bySession = new Map();
  for (const r of results) {
    const existing = bySession.get(r.sessionId);
    if (!existing || r.score > existing.score) {
      bySession.set(r.sessionId, r);
    }
  }
  const hits = [];
  for (const [sessionId, result] of bySession) {
    const session = await store.getSession(sessionId);
    hits.push({
      sessionId,
      snippet: result.snippet,
      score: result.score,
      title: session?.title,
    });
  }
  return hits.sort((a, b) => b.score - a.score);
}
/**
 * Format session usage into human-readable cost and token lines.
 * Extracted for unit-testability.
 */
export function formatSessionCost(usage) {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, estimatedCostUsd } =
    usage;
  const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
  const cacheSavingsPct =
    totalInput > 0 ? Math.min(99, Math.max(0, Math.round((cacheReadTokens / totalInput) * 90))) : 0;
  const tokenLine =
    `in=${inputTokens.toLocaleString()}  out=${outputTokens.toLocaleString()}` +
    `  cache_read=${cacheReadTokens.toLocaleString()}  cache_creation=${cacheCreationTokens.toLocaleString()}`;
  const costLine = `$${estimatedCostUsd.toFixed(3)}  (cache savings: ~${cacheSavingsPct}%)`;
  return { tokenLine, costLine, cacheSavingsPct };
}
// ---------------------------------------------------------------------------
// ethos session show <id> — exported for routing from index.ts if needed
// ---------------------------------------------------------------------------
export async function runSessionShow(argv) {
  const sessionId = argv[0];
  const jsonMode = argv.includes('--json');
  if (!sessionId) {
    process.stderr.write('Usage: ethos sessions show <session_id> [--json]\n');
    process.exit(1);
  }
  const dbPath = join(ethosDir(), 'sessions.db');
  const store = new SQLiteSessionStore(dbPath);
  try {
    const session = await store.getSession(sessionId);
    if (!session) {
      throw new EthosError({
        code: 'SESSION_NOT_FOUND',
        cause: `Session not found: ${sessionId}`,
        action: 'Check the session ID with `ethos sessions list`.',
      });
    }
    const compressions = await store.listCompressions(sessionId);
    const { tokenLine, costLine } = formatSessionCost(session.usage);
    const compactionCount = compressions.length;
    const firstCompaction = compressions[0];
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({
          id: session.id,
          key: session.key,
          title: session.title,
          turns: session.usage.apiCallCount,
          usage: session.usage,
          compactionCount,
        })}\n`,
      );
      return;
    }
    const isTTY = process.stdout.isTTY;
    const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
    const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
    const compactionSuffix =
      compactionCount > 0 && firstCompaction
        ? `  ${dim(`(after turn ~${firstCompaction.originalCount})`)}`
        : '';
    process.stdout.write(
      `\n${bold('Session:')} ${session.key}${session.title ? `  "${session.title}"` : ''}\n` +
        `${bold('Turns:')}   ${session.usage.apiCallCount}\n` +
        `${bold('Tokens:')}  ${tokenLine}\n` +
        `${bold('Cost:')}    ${costLine}\n` +
        `${bold('Compactions:')} ${compactionCount}${compactionSuffix}\n\n`,
    );
  } finally {
    store.close();
  }
}
// ---------------------------------------------------------------------------
// CLI command — ethos sessions <sub> [args]
// ---------------------------------------------------------------------------
function timeAgo(date) {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'yesterday';
  return `${diffDays}d ago`;
}
export async function runSessionsCommand(sub, argv) {
  const dbPath = join(ethosDir(), 'sessions.db');
  const store = new SQLiteSessionStore(dbPath);
  try {
    switch (sub) {
      case 'list':
      case '': {
        const limitIdx = argv.indexOf('--limit');
        const limit = limitIdx !== -1 ? parseInt(argv[limitIdx + 1] ?? '20', 10) : 20;
        const keyIdx = argv.indexOf('--key');
        const keyPrefix = keyIdx !== -1 ? argv[keyIdx + 1] : undefined;
        const items = await listSessions(store, { limit, keyPrefix });
        if (items.length === 0) {
          console.log('No sessions found.');
          break;
        }
        const idW = 24;
        const titleW = 24;
        const keyW = 16;
        const header = `${'ID'.padEnd(idW) + 'TITLE'.padEnd(titleW) + 'KEY'.padEnd(keyW)}LAST ACTIVE`;
        console.log(`\n${header}`);
        console.log('-'.repeat(header.length));
        for (const item of items) {
          console.log(
            item.id.slice(0, idW - 1).padEnd(idW) +
              (item.title ?? '').slice(0, titleW - 1).padEnd(titleW) +
              item.key.slice(0, keyW - 1).padEnd(keyW) +
              timeAgo(item.updatedAt),
          );
        }
        console.log();
        break;
      }
      case 'rename': {
        const sessionId = argv[0];
        const title = argv.slice(1).join(' ');
        if (!sessionId || !title) {
          console.error('Usage: ethos sessions rename <session_id> <title>');
          process.exit(1);
        }
        await renameSession(store, sessionId, title);
        console.log(`Renamed to: ${title}`);
        break;
      }
      case 'delete': {
        const sessionId = argv[0];
        if (!sessionId) {
          console.error('Usage: ethos sessions delete <session_id>');
          process.exit(1);
        }
        const skipConfirm = argv.includes('-y') || argv.includes('--yes');
        if (!skipConfirm) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          await new Promise((resolve) => {
            rl.question(`Delete session ${sessionId}? [y/N] `, (answer) => {
              rl.close();
              if (answer.toLowerCase() !== 'y') {
                console.log('Cancelled.');
                process.exit(0);
              }
              resolve();
            });
          });
        }
        await deleteSessionById(store, sessionId);
        console.log(`Deleted: ${sessionId}`);
        break;
      }
      case 'search': {
        const query = argv[0];
        if (!query) {
          console.error('Usage: ethos sessions search "<query>" [--limit 20]');
          process.exit(1);
        }
        const limitIdx = argv.indexOf('--limit');
        const limit = limitIdx !== -1 ? parseInt(argv[limitIdx + 1] ?? '20', 10) : 20;
        const hits = await searchSessions(store, query, { limit });
        if (hits.length === 0) {
          console.log('No matching sessions.');
          break;
        }
        for (const hit of hits) {
          const label = hit.title ? `${hit.sessionId}  "${hit.title}"` : hit.sessionId;
          console.log(`\n${label}`);
          console.log(`  ${hit.snippet.slice(0, 120)}`);
        }
        console.log();
        break;
      }
      case 'show': {
        await runSessionShow(argv);
        break;
      }
      default:
        console.error(`Unknown sessions subcommand: ${sub}`);
        console.log('Usage: ethos sessions [list | show | rename | delete | search]');
        process.exit(1);
    }
  } finally {
    store.close();
  }
}
