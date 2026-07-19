// `ethos memory pending [--approve <id> | --reject <id>]` — the approve-before-
// store queue (memory-lifecycle L2, §3b). Lists parked memory candidates for the
// active personality and lets you approve (replay into durable memory, recorded
// under the original source + approvedBy) or reject (tombstone the fact so it is
// never re-proposed). This is OpenClaw's `/memory promote` preview, generalized.
import { ethosDir, readConfig } from '@ethosagent/config';
import type { PendingEntry } from '@ethosagent/wiring';
import { createPendingMemoryStore } from '@ethosagent/wiring';
import { writeJson } from '../json-output';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runMemoryPending(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const jsonMode = args.includes('--json');

  const config = await readConfig(getStorage(), await getSecretsResolver());
  const personalityId = flag('--personality') ?? config?.personality ?? 'default';
  const scopeId = `personality:${personalityId}`;

  const { store } = createPendingMemoryStore({
    dataDir: ethosDir(),
    storage: getStorage(),
    // Backend selection — approve replays into the configured backend (vault
    // under memory: vault), not an assumed markdown root.
    ...(config ? { config } : {}),
    ...(config?.memoryApproval?.cap !== undefined ? { cap: config.memoryApproval.cap } : {}),
    ...(config?.memoryApproval?.ttlDays !== undefined
      ? { ttlMs: config.memoryApproval.ttlDays * DAY_MS }
      : {}),
  });

  const approveId = flag('--approve');
  if (approveId !== undefined) {
    const result = await store.approve(scopeId, approveId, 'cli');
    if (!result.ok) {
      console.error(`No pending candidate with id "${approveId}" in ${personalityId}'s queue.`);
      process.exit(1);
    }
    console.log(`${c.green}Approved${c.reset} ${approveId} → written to durable memory.`);
    return;
  }

  const rejectId = flag('--reject');
  if (rejectId !== undefined) {
    const result = await store.reject(scopeId, rejectId, 'cli');
    if (!result.ok) {
      console.error(`No pending candidate with id "${rejectId}" in ${personalityId}'s queue.`);
      process.exit(1);
    }
    console.log(`${c.yellow}Rejected${c.reset} ${rejectId} → tombstoned; will not be re-proposed.`);
    return;
  }

  const entries = await store.list(scopeId);
  if (jsonMode) {
    writeJson({ entries });
    return;
  }
  if (entries.length === 0) {
    console.log('No pending memory candidates.');
    return;
  }
  for (const e of entries) {
    printEntry(e);
  }
  console.log(`${c.dim}Use --approve <id> to write one, --reject <id> to tombstone it.${c.reset}`);
}

function printEntry(e: PendingEntry): void {
  const when = new Date(e.proposedAt).toISOString().slice(0, 16).replace('T', ' ');
  const key = 'key' in e.update ? e.update.key : '';
  console.log(
    `${c.bold}${e.id}${c.reset} ${c.dim}${when}${c.reset} ${c.cyan}${e.source}${c.reset} ` +
      `${c.bold}${key}${c.reset} ${c.dim}[${e.update.action}]${c.reset}`,
  );
  const preview = summarizeUpdate(e);
  if (preview) console.log(`  ${preview}`);
}

function summarizeUpdate(e: PendingEntry): string {
  const u = e.update;
  if (u.action === 'add' || u.action === 'replace') {
    return u.content.trim().slice(0, 200);
  }
  if (u.action === 'remove') return `remove lines matching "${u.substringMatch}"`;
  return `delete ${u.key}`;
}
