// Testable implementations of `ethos evolve status|apply|prune|archive`.
// These accept an explicit `ethosDir` string (and, for the queue verbs, the
// learning inbox) so tests can inject a temp dir and an in-memory inbox without
// mocking the module-level `ethosDir()` function.

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

// ---------------------------------------------------------------------------
// ethos evolve status
// ---------------------------------------------------------------------------

interface HistoryRecord {
  ranAt: string;
  evalOutputPath?: string;
  rewritesProposed: number;
  newSkillsProposed: number;
  skipped: unknown[];
}

function parseLastRecord(raw: string): HistoryRecord | null {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as HistoryRecord;
  } catch {
    return null;
  }
}

// The pending count is the learning inbox's WAITING SKILL CANDIDATES, every
// origin (L-T8). It used to count `skills/pending/*.md`, a queue the legacy
// import drains and nothing writes any more — so it reported "0 pending" while
// the inbox held candidates.

export async function runEvolveStatus(
  _args: string[],
  ethosDir: string,
  inbox: EvolveInboxReader,
): Promise<void> {
  const historyPath = join(ethosDir, 'evolver-history.jsonl');

  // Read history
  let lastRecord: HistoryRecord | null = null;
  try {
    const raw = await readFile(historyPath, 'utf-8');
    lastRecord = parseLastRecord(raw);
  } catch {
    // No history yet
  }

  const waiting = await inbox.list({ kind: 'skill', status: WAITING });

  if (!lastRecord && waiting.length === 0) {
    console.log(`${c.dim}No proposals yet. Run: ethos evolve run${c.reset}`);
    return;
  }

  if (lastRecord) {
    const ranAt = new Date(lastRecord.ranAt).toLocaleString();
    const proposed = (lastRecord.rewritesProposed ?? 0) + (lastRecord.newSkillsProposed ?? 0);
    const skipped = Array.isArray(lastRecord.skipped) ? lastRecord.skipped.length : 0;
    console.log(`${c.bold}Last run:${c.reset} ${ranAt}`);
    console.log(`  ${c.dim}proposed: ${proposed}  skipped: ${skipped}${c.reset}`);
    console.log('');
  }

  if (waiting.length === 0) {
    console.log(`${c.dim}No pending proposals.${c.reset}`);
    return;
  }

  console.log(`${c.bold}Pending (${waiting.length}):${c.reset}`);
  for (const candidate of waiting) {
    console.log(
      `  ${candidate.id}  ${basename(candidate.destination)}  ${c.dim}${candidate.personalityId} · ${candidate.origin} · ${candidate.verdict ?? 'not run'}${c.reset}`,
    );
  }
  console.log('');
  console.log(
    `Approve with: ${c.bold}ethos evolve apply <candidate-id | filename>${c.reset}  or  ${c.bold}ethos learning approve <id> --override "<reason>"${c.reset}`,
  );
}

// ---------------------------------------------------------------------------
// ethos evolve apply <candidate-id | filename> | --all
// ---------------------------------------------------------------------------
//
// L-T8 (plan `trust-before-reach.md` Part 4) — a thin adapter over the learning
// inbox. It used to rename files out of `skills/pending/`, a queue nothing
// writes any more (every writer submits a candidate, and the legacy import
// drains the old directory). It now approves a WAITING SKILL CANDIDATE of any
// origin — so a nightly or live-fork candidate is found, which the old command
// could never do — through `LearningInbox.approve`.
//
// What it can no longer do: approve a candidate whose replay did not pass.
// `apply` has no way to carry a reason, and the inbox refuses a non-`pass`
// approval without one (`override_required`). Such a candidate is left waiting
// and named with the command that can approve it, `ethos learning approve <id>
// --override "<reason>"`. Frontmatter, scope and staleness are `promote()`'s.

/** The slice of a learning candidate this command prints. */
export interface EvolveApplyCandidate {
  id: string;
  destination: string;
  verdict: string | null;
}

/** The slice `status` and `prune` read. */
export interface EvolveInboxCandidate extends EvolveApplyCandidate {
  personalityId: string;
  origin: string;
  submittedAt: string;
}

type EvolveApplyRefusal = { ok: false; code: string; reason: string };

/** Statuses a human can still decide on — the inbox's `AWAITING_DECISION`. */
const WAITING = ['pending_replay', 'pending_review'] as const;

/** `LearningInbox.list`, declared structurally (see `EvolveApplyInbox`). */
export interface EvolveInboxReader {
  list(filter: {
    kind: 'skill';
    status: readonly ('pending_replay' | 'pending_review')[];
  }): Promise<EvolveInboxCandidate[]>;
}

/** `LearningInbox.list` + `reject`, declared structurally, for `prune`. */
export interface EvolvePruneInbox extends EvolveInboxReader {
  reject(
    candidateId: string,
    opts: { actor: string; decidedBy: string; reason?: string },
  ): Promise<{ ok: true } | EvolveApplyRefusal>;
}

/**
 * The `LearningInbox` methods `evolve apply` uses, declared structurally so this
 * package does not depend on `@ethosagent/learning-inbox`. The CLI passes the
 * real inbox (`createCliLearningInbox` in `apps/ethos/src/wiring.ts`).
 */
export interface EvolveApplyInbox {
  list(filter: {
    kind: 'skill';
    status: readonly ('pending_replay' | 'pending_review')[];
  }): Promise<EvolveApplyCandidate[]>;
  resolve(
    ref: string,
    filter: { kind: 'skill' },
  ): Promise<{ ok: true; value: EvolveApplyCandidate } | EvolveApplyRefusal>;
  approve(
    candidateId: string,
    opts: { actor: string; decidedBy: string },
  ): Promise<{ ok: true; value: { candidate: EvolveApplyCandidate } } | EvolveApplyRefusal>;
}

const DECIDED_BY = 'ethos evolve apply';

async function approveCandidate(
  inbox: EvolveApplyInbox,
  candidate: EvolveApplyCandidate,
): Promise<boolean> {
  const label = `${candidate.id} (${basename(candidate.destination)})`;
  const result = await inbox.approve(candidate.id, { actor: 'cli', decidedBy: DECIDED_BY });
  if (result.ok) {
    console.log(`${c.green}approved${c.reset} ${label} → ${result.value.candidate.destination}`);
    return true;
  }
  if (result.code === 'override_required') {
    console.error(`${c.red}not approved${c.reset} ${label} — ${result.reason}`);
    console.error(
      `${c.dim}Approve with a reason: ethos learning approve ${candidate.id} --override "<reason>"${c.reset}`,
    );
    return false;
  }
  console.error(`${c.red}not approved${c.reset} ${label} — ${result.reason}`);
  return false;
}

export async function runEvolveApply(args: string[], inbox: EvolveApplyInbox): Promise<void> {
  if (args.includes('--all')) {
    const waiting = await inbox.list({ kind: 'skill', status: WAITING });
    if (waiting.length === 0) {
      console.log(`${c.dim}No skill candidates waiting.${c.reset}`);
      return;
    }
    for (const candidate of waiting) await approveCandidate(inbox, candidate);
    return;
  }

  const ref = args.find((a) => !a.startsWith('-'));
  if (!ref) {
    console.error(
      `${c.red}Usage: ethos evolve apply <candidate-id | filename.md> | --all${c.reset}`,
    );
    process.exit(1);
  }

  const found = await inbox.resolve(ref, { kind: 'skill' });
  if (!found.ok) {
    console.error(`${c.red}${found.reason}${c.reset}`);
    console.error(`${c.dim}List waiting candidates with: ethos learning list${c.reset}`);
    process.exit(1);
  }
  if (!(await approveCandidate(inbox, found.value))) process.exit(1);
}

// ---------------------------------------------------------------------------
// ethos evolve prune [--older-than <days>] [--yes]
// ---------------------------------------------------------------------------
//
// L-T8 — it used to delete `skills/pending/*.md` files older than N days. That
// directory is retired (drained by the legacy import), so deleting from it would
// silently do nothing. Prune now REJECTS waiting skill candidates submitted more
// than N days ago, through `LearningInbox.reject` — rejecting only narrows, and
// each rejection writes its own `learning.reject` audit row. Nothing is deleted:
// the candidate stays on the record as `rejected`. Still confirmed unless --yes.

function parseOlderThan(args: string[], defaultDays: number): number {
  const idx = args.indexOf('--older-than');
  if (idx === -1 || idx + 1 >= args.length) return defaultDays;
  const val = Number(args[idx + 1]);
  return Number.isFinite(val) && val > 0 ? val : defaultDays;
}

function askConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function runEvolvePrune(args: string[], inbox: EvolvePruneInbox): Promise<void> {
  const days = parseOlderThan(args, 7);
  const yes = args.includes('--yes');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const waiting = await inbox.list({ kind: 'skill', status: WAITING });
  const stale = waiting.filter((candidate) => {
    const at = Date.parse(candidate.submittedAt);
    return Number.isFinite(at) && at < cutoff;
  });

  if (stale.length === 0) {
    console.log(`${c.dim}No skill candidates waiting longer than ${days} days.${c.reset}`);
    return;
  }

  console.log(
    `${c.dim}prune rejects waiting skill candidates in the learning inbox; each rejection is audited and nothing is deleted.${c.reset}`,
  );
  if (!yes) {
    for (const candidate of stale) {
      console.log(
        `  ${candidate.id}  ${basename(candidate.destination)}  ${candidate.submittedAt}`,
      );
    }
    const confirmed = await askConfirm(`Reject ${stale.length} candidate(s)? [y/N] `);
    if (!confirmed) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return;
    }
  }

  let rejected = 0;
  for (const candidate of stale) {
    const result = await inbox.reject(candidate.id, {
      actor: 'cli',
      decidedBy: 'ethos evolve prune',
      reason: `pruned: waiting longer than ${days} days`,
    });
    if (result.ok) {
      rejected++;
    } else {
      console.error(`${c.red}not rejected${c.reset} ${candidate.id} — ${result.reason}`);
    }
  }
  console.log(
    `${c.green}rejected ${rejected} skill candidate(s) waiting longer than ${days} days${c.reset}`,
  );
}

// ---------------------------------------------------------------------------
// ethos evolve archive [--older-than <days>]
// ---------------------------------------------------------------------------

export async function runEvolveArchive(args: string[], ethosDir: string): Promise<void> {
  const days = parseOlderThan(args, 30);
  const skillsDir = join(ethosDir, 'skills');

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    console.log(`${c.dim}No skills directory.${c.reset}`);
    return;
  }

  const mds = entries.filter((e) => e.endsWith('.md'));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stale: string[] = [];

  for (const f of mds) {
    try {
      const info = await stat(join(skillsDir, f));
      if (info.mtimeMs < cutoff) stale.push(f);
    } catch {
      // skip unreadable files
    }
  }

  if (stale.length === 0) {
    console.log(`${c.dim}No active skills older than ${days} days.${c.reset}`);
    return;
  }

  const prefix = new Date().toISOString().slice(0, 10);
  const archiveDir = join(skillsDir, '.archive', prefix);
  await mkdir(archiveDir, { recursive: true });

  for (const f of stale) {
    await rename(join(skillsDir, f), join(archiveDir, f));
  }

  const manifest = {
    archivedAt: new Date().toISOString(),
    files: stale,
  };
  await writeFile(join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`${c.green}archived ${stale.length} skills to .archive/${prefix}/${c.reset}`);
}
