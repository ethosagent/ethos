// The learning inbox's audit log: `~/.ethos/learning/audit.jsonl`.
//
// Append-only, one JSON object per line, written with `Storage.append`. It is
// the record of WHO changed a candidate and WHY, which the candidate file
// itself cannot be: `candidate.json` is rewritten in place on every transition,
// so the previous status is gone the moment the next one lands.
//
// L-D10 is explicit that a status change is check-then-write and not atomic
// across processes — a human approval and a nightly auto-promotion landing in
// the same instant can both apply. This file is how that is noticed after the
// fact, which is why every writer appends before it returns.

import type { Storage } from '@ethosagent/types';
import { auditPath, learningDir } from './paths';
import type { CandidateStatus, CandidateVerdict } from './store';

/**
 * What happened. Deliberately small: L-T5 (promote / rollback) and L-T8 (the
 * human decisions and their `recordSafetyApproval` codes) add their own
 * members rather than overloading `status`.
 */
export type LearningAuditAction =
  /** A candidate entered the inbox through `submitCandidate`. */
  | 'submitted'
  /** …through the one-time legacy queue drain (`importLegacyQueues`). */
  | 'imported'
  /** A status and/or verdict change on an existing candidate. */
  | 'status'
  /** A replay scorecard was written to `replay-<runId>.json`. */
  | 'replay';

export interface LearningAuditEntry {
  /** ISO 8601. */
  at: string;
  candidateId: string;
  action: LearningAuditAction;
  /** Status before the change. Absent on `submitted` / `imported`. */
  from?: CandidateStatus;
  to?: CandidateStatus;
  verdict?: CandidateVerdict | null;
  /** Who acted: `'nightly'`, `'cli'`, `'web'`, `'legacy-import'`, … */
  actor?: string;
  /** Free text — an override reason, a refusal cause, a run id. */
  reason?: string;
}

/** Append one line. Creates `learning/` and the file if they are missing. */
export async function appendAudit(
  storage: Storage,
  dataDir: string,
  entry: Omit<LearningAuditEntry, 'at'>,
  now: () => number = Date.now,
): Promise<LearningAuditEntry> {
  const line: LearningAuditEntry = { at: new Date(now()).toISOString(), ...entry };
  await storage.mkdir(learningDir(dataDir));
  await storage.append(auditPath(dataDir), `${JSON.stringify(line)}\n`);
  return line;
}

/**
 * Read the log back, oldest first.
 *
 * Tolerant of a malformed line: a log nobody can parse is a log nobody can
 * read, and one torn line must not hide the rest of a candidate's history.
 * Unparseable lines are skipped, not repaired.
 */
export async function readAudit(
  storage: Storage,
  dataDir: string,
  filter?: { candidateId?: string },
): Promise<LearningAuditEntry[]> {
  const raw = await storage.read(auditPath(dataDir));
  if (!raw) return [];
  const out: LearningAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const entry = parsed as LearningAuditEntry;
    if (typeof entry.candidateId !== 'string' || typeof entry.action !== 'string') continue;
    if (filter?.candidateId && entry.candidateId !== filter.candidateId) continue;
    out.push(entry);
  }
  return out;
}
