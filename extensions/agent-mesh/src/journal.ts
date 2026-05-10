import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Minimal observability surface the mesh journal needs. Defined locally so
 * this package depends only on `@ethosagent/types` + `@ethosagent/storage-fs`;
 * any adapter exposing this method shape (e.g. wiring's EthosObservability)
 * is a fit.
 */
export interface MeshJournalObservability {
  recordInstallEvent(opts: { code?: string; cause?: string }): void;
}

let _obs: MeshJournalObservability | undefined;

/**
 * Wire up an observability adapter so mesh events are also written to
 * observability.db. Call this once during CLI startup with the app's
 * EthosObservability adapter (or any object satisfying
 * `MeshJournalObservability`).
 */
export function setMeshObservabilityService(obs: MeshJournalObservability): void {
  _obs = obs;
}

// CC-4: mesh.jsonl atomic line writes — O_APPEND + 4 KB row cap.
//
// POSIX guarantees that a single write(2) call on an O_APPEND file is atomic
// when the buffer is < PIPE_BUF (4096 bytes on Linux/macOS). Larger writes can
// interleave at byte level across concurrent writers, producing unparseable rows.
//
// Contract (must hold for every writer that lands rows in mesh.jsonl):
//   1. Open with O_APPEND.
//   2. Serialise each row to a single string with a trailing \n.
//   3. The string must be < MAX_ROW_BYTES; truncate long fields if needed.
//   4. Write in one synchronous call (appendFileSync = single write(2) on POSIX).

const MAX_ROW_BYTES = 4000; // < 4096 PIPE_BUF with margin for newline + metadata

export interface MeshJournalEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export function meshJournalPath(): string {
  return join(homedir(), '.ethos', 'logs', 'mesh.jsonl');
}

/**
 * Append one event to mesh.jsonl.
 *
 * The row is serialised to JSON, capped at MAX_ROW_BYTES by truncating
 * the `details` field (or adding a truncation marker), then written
 * in a single O_APPEND call so the row is atomic on POSIX.
 */
export function appendMeshJournal(entry: MeshJournalEntry): void {
  const logPath = meshJournalPath();
  mkdirSync(dirname(logPath), { recursive: true });

  let row = JSON.stringify(entry);

  if (Buffer.byteLength(row, 'utf8') >= MAX_ROW_BYTES) {
    // Truncate the details field to fit within the cap.
    const truncated = { ...entry, details: '[truncated — exceeded 4 KB cap]' };
    row = JSON.stringify(truncated);
  }

  appendFileSync(logPath, `${row}\n`);
  try {
    _obs?.recordInstallEvent({
      code: entry.event,
      cause: JSON.stringify(entry).slice(0, 200),
    });
  } catch {
    // Observability is best-effort — never mask the primary journal path.
  }
}
