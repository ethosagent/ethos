import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadEvolveConfig,
  runEvolveApply,
  runEvolveArchive,
  runEvolvePrune,
  runEvolveStatus,
  SkillEvolver,
} from '@ethosagent/skill-evolver';
import { type EthosConfig, ethosDir } from '../config';
import { createLLM } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

interface ParsedArgs {
  evalOutput: string;
  listPending: boolean;
  approve: string;
  reject: string;
  approveAll: boolean;
  autoApprove: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let evalOutput = '';
  let listPending = false;
  let approve = '';
  let reject = '';
  let approveAll = false;
  let autoApprove = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--eval-output') {
      evalOutput = args[++i] ?? '';
    } else if (arg === '--list-pending') {
      listPending = true;
    } else if (arg === '--approve' || arg === '--accept') {
      // E3 — `--accept` is the plan's spelling; `--approve` is the original.
      // Both behave identically.
      approve = args[++i] ?? '';
    } else if (arg === '--reject') {
      reject = args[++i] ?? '';
    } else if (arg === '--approve-all' || arg === '--accept-all') {
      approveAll = true;
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    }
  }

  return { evalOutput, listPending, approve, reject, approveAll, autoApprove };
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  ethos evolve status');
  console.log('  ethos evolve run [--quiet]');
  console.log('  ethos evolve apply <filename> | --all [-y]');
  console.log('  ethos evolve prune [--older-than <days>] [--yes]');
  console.log('  ethos evolve archive [--older-than <days>]');
  console.log('  ethos evolve --eval-output <file.eval.jsonl> [--auto-approve]');
  console.log('  ethos evolve --list-pending');
  console.log('  ethos evolve --approve <filename> | --approve-all');
  console.log('  ethos evolve --reject <filename>');
}

export async function runEvolve(args: string[], config: EthosConfig): Promise<void> {
  // New subcommand routing: status / run / apply
  const sub = args[0];
  const dir = ethosDir();

  if (sub === 'status') {
    await runEvolveStatus(args.slice(1), dir);
    return;
  }

  if (sub === 'apply') {
    await runEvolveApply(args.slice(1), dir);
    return;
  }

  if (sub === 'run') {
    await runEvolveRun(args.slice(1), config, dir);
    return;
  }

  if (sub === 'prune') {
    await runEvolvePrune(args.slice(1), dir);
    return;
  }

  if (sub === 'archive') {
    await runEvolveArchive(args.slice(1), dir);
    return;
  }

  // Legacy flag-based routing (backwards-compatible)
  const opts = parseArgs(args);
  const skillsDir = join(dir, 'skills');
  const pendingDir = join(skillsDir, 'pending');

  if (opts.listPending) {
    await listPending(pendingDir);
    return;
  }

  if (opts.approveAll) {
    await approveAll(pendingDir, skillsDir);
    return;
  }

  if (opts.approve) {
    await approveOne(opts.approve, pendingDir, skillsDir);
    return;
  }

  if (opts.reject) {
    await rejectOne(opts.reject, pendingDir);
    return;
  }

  if (opts.evalOutput) {
    await runAnalyze(opts.evalOutput, config, skillsDir, pendingDir, opts.autoApprove);
    return;
  }

  printUsage();
}

// ---------------------------------------------------------------------------
// ethos evolve run [--quiet]
// ---------------------------------------------------------------------------
// Generates an eval output file from recent sessions and runs the evolver
// against it. This is the cron-safe equivalent of `--eval-output` — it
// sources sessions from the SQLite session store rather than requiring the
// caller to supply a pre-baked eval file.

async function runEvolveRun(args: string[], config: EthosConfig, dir: string): Promise<void> {
  const quiet = args.includes('--quiet');
  const skillsDir = join(dir, 'skills');
  const pendingDir = join(skillsDir, 'pending');

  // Export recent sessions to a temporary eval file.
  // The SQLite session store doesn't expose a built-in eval exporter, so we
  // check whether there are any sessions at all via the DB file's presence.
  const sessionsDb = join(dir, 'sessions.db');
  try {
    await stat(sessionsDb);
  } catch {
    if (!quiet) console.log(`${c.dim}No sessions to analyze.${c.reset}`);
    return;
  }

  // Build a temporary eval file from the session DB.
  const tmpEvalPath = join(dir, `.evolver-run-${Date.now()}.eval.jsonl`);
  let wroteRecords = false;
  try {
    wroteRecords = await exportSessionsToEval(sessionsDb, tmpEvalPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!quiet) console.error(`${c.red}Failed to export sessions:${c.reset} ${msg}`);
    return;
  }

  if (!wroteRecords) {
    if (!quiet) console.log(`${c.dim}No sessions to analyze.${c.reset}`);
    return;
  }

  try {
    await runAnalyze(tmpEvalPath, config, skillsDir, pendingDir, false);
  } finally {
    await rm(tmpEvalPath, { force: true });
  }
}

const ROLE_MAP: Record<string, 'user' | 'assistant' | 'tool'> = {
  user: 'user',
  assistant: 'assistant',
  tool_result: 'tool',
  user_steer: 'user',
};

/**
 * Export messages from the session SQLite DB into an eval JSONL file.
 * Returns true if at least one record was written.
 */
export async function exportSessionsToEval(dbPath: string, outPath: string): Promise<boolean> {
  // Dynamic import keeps better-sqlite3 out of the require graph for codepaths
  // that don't use `evolve run`.
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Fetch messages from the last 7 days across all sessions.
    // JOIN sessions to get the key (messages only has session_id FK, not session_key).
    // LIMIT 2000 prevents loading the entire table into memory on busy installs.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT s.key AS session_key, m.role, m.content
           FROM messages m
           JOIN sessions s ON m.session_id = s.id
          WHERE m.timestamp >= ?
          ORDER BY m.timestamp ASC
          LIMIT 2000`,
      )
      .all(cutoff) as Array<{ session_key: string; role: string; content: string }>;

    if (rows.length === 0) return false;

    const lines: string[] = [];
    const seenSessions = new Map<string, number>();
    for (const row of rows) {
      const mappedRole = ROLE_MAP[row.role];
      if (!mappedRole || typeof row.content !== 'string') continue;
      let taskIdx = seenSessions.get(row.session_key);
      if (taskIdx === undefined) {
        taskIdx = seenSessions.size;
        seenSessions.set(row.session_key, taskIdx);
      }
      const record = {
        schema_version: '1.0',
        task_id: `session-${taskIdx}`,
        turn: 0,
        role: mappedRole,
        content: row.content,
      };
      lines.push(JSON.stringify(record));
    }

    if (lines.length === 0) return false;

    const { writeFile } = await import('node:fs/promises');
    await writeFile(outPath, `${lines.join('\n')}\n`, 'utf-8');
    return true;
  } finally {
    db.close();
  }
}

async function runAnalyze(
  evalOutput: string,
  config: EthosConfig,
  skillsDir: string,
  pendingDir: string,
  autoApprove: boolean,
): Promise<void> {
  try {
    await stat(evalOutput);
  } catch {
    console.error(`${c.red}Cannot read eval output: ${evalOutput}${c.reset}`);
    process.exit(1);
  }

  await mkdir(skillsDir, { recursive: true });

  const evolveConfig = await loadEvolveConfig(join(ethosDir(), 'evolve-config.json'));
  const llm = await createLLM(config);

  console.log(
    `${c.bold}ethos evolve${c.reset}  ${c.dim}eval: ${evalOutput} · model: ${llm.model}${c.reset}`,
  );

  const evolver = new SkillEvolver({
    evalOutputPath: evalOutput,
    skillsDir,
    pendingDir,
    config: evolveConfig,
    llm,
  });

  const ranAt = new Date().toISOString();
  const result = await evolver.evolve();

  // Append a record to ~/.ethos/evolver-history.jsonl so the web Skills
  // tab's "Run history" panel surfaces it. Schema mirrors the EvolverRun
  // wire shape consumed by EvolverRepository.listHistory.
  const historyPath = join(ethosDir(), 'evolver-history.jsonl');
  const record = {
    ranAt,
    evalOutputPath: evalOutput,
    rewritesProposed: result.rewritesWritten.length,
    newSkillsProposed: result.newSkillsWritten.length,
    skipped: result.skipped,
  };
  try {
    await appendFile(historyPath, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    // History is observability — don't fail the evolve run if the log
    // can't be written. Surface a soft warning so the user can fix it.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${c.yellow}Could not append to evolver history:${c.reset} ${message}`);
  }

  console.log('');
  console.log(`${c.dim}skills analyzed:${c.reset} ${result.plan.skillStats.length}`);
  console.log(`${c.dim}rewrite candidates:${c.reset} ${result.plan.rewriteCandidates.length}`);
  console.log(`${c.dim}new-skill candidates:${c.reset} ${result.plan.newSkillCandidates.length}`);
  console.log('');

  if (result.rewritesWritten.length > 0) {
    console.log(`${c.green}rewrites written:${c.reset}`);
    for (const f of result.rewritesWritten) console.log(`  ${join(pendingDir, f)}`);
  }
  if (result.newSkillsWritten.length > 0) {
    console.log(`${c.green}new skills written:${c.reset}`);
    for (const f of result.newSkillsWritten) console.log(`  ${join(pendingDir, f)}`);
  }
  if (result.skipped.length > 0) {
    console.log(`${c.yellow}skipped:${c.reset}`);
    for (const s of result.skipped) console.log(`  ${s.kind} ${s.target} — ${s.reason}`);
  }
  if (
    result.rewritesWritten.length === 0 &&
    result.newSkillsWritten.length === 0 &&
    result.skipped.length === 0
  ) {
    console.log(`${c.dim}nothing to evolve.${c.reset}`);
    return;
  }

  const allPending = [...result.rewritesWritten, ...result.newSkillsWritten];
  if (autoApprove && allPending.length > 0) {
    console.log('');
    console.log(`${c.bold}--auto-approve${c.reset} promoting ${allPending.length} file(s)...`);
    for (const f of allPending) {
      await rename(join(pendingDir, f), join(skillsDir, f));
      console.log(`  → ${join(skillsDir, f)}`);
    }
    return;
  }

  console.log('');
  console.log(`Review with: ${c.bold}ethos evolve --list-pending${c.reset}`);
  console.log(`Approve with: ${c.bold}ethos evolve --approve <filename>${c.reset}`);
}

async function listPending(pendingDir: string): Promise<void> {
  // E3 — list both legacy `<skillsDir>/pending/` (eval-driven candidates)
  // and the per-personality auto-trigger dirs at
  // `<skillsDir>/.pending/<personalityId>/`.
  const sections: Array<{ label: string; files: string[] }> = [];

  try {
    const entries = await readdir(pendingDir);
    const mds = entries.filter((e) => e.endsWith('.md')).sort();
    if (mds.length > 0) sections.push({ label: pendingDir, files: mds });
  } catch {
    // No legacy pending dir — fine.
  }

  const autoRoot = join(ethosDir(), 'skills', '.pending');
  try {
    const personalities = await readdir(autoRoot);
    for (const personality of personalities.sort()) {
      const personalityDir = join(autoRoot, personality);
      try {
        const inner = await readdir(personalityDir);
        const mds = inner.filter((e) => e.endsWith('.md')).sort();
        if (mds.length > 0) {
          sections.push({ label: `${personalityDir} (auto)`, files: mds });
        }
      } catch {
        // Skip non-directories.
      }
    }
  } catch {
    // No auto-trigger queue yet.
  }

  if (sections.length === 0) {
    console.log(`${c.dim}No pending skills.${c.reset}`);
    return;
  }
  for (const section of sections) {
    console.log(`${c.bold}Pending skills${c.reset}  ${c.dim}${section.label}${c.reset}`);
    for (const f of section.files) console.log(`  ${f}`);
  }
}

async function approveAll(pendingDir: string, skillsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    console.log(`${c.dim}No pending skills.${c.reset}`);
    return;
  }
  const mds = entries.filter((e) => e.endsWith('.md'));
  if (mds.length === 0) {
    console.log(`${c.dim}No pending skills.${c.reset}`);
    return;
  }
  for (const f of mds) {
    await rename(join(pendingDir, f), join(skillsDir, f));
    console.log(`${c.green}approved${c.reset} ${f}`);
  }
}

async function approveOne(fileName: string, pendingDir: string, skillsDir: string): Promise<void> {
  const safe = ensureSafeFilename(fileName);
  if (!safe) {
    console.error(`${c.red}Invalid filename: ${fileName}${c.reset}`);
    process.exit(1);
  }
  // E3 — try the legacy pending dir first, then walk the per-personality
  // auto-trigger queues. The first match wins.
  const candidates = [join(pendingDir, safe), ...(await autoPendingPaths(safe))];
  for (const path of candidates) {
    try {
      await rename(path, join(skillsDir, safe));
      console.log(`${c.green}approved${c.reset} ${safe}`);
      return;
    } catch {
      // Next candidate.
    }
  }
  console.error(`${c.red}No such pending skill: ${safe}${c.reset}`);
  process.exit(1);
}

async function rejectOne(fileName: string, pendingDir: string): Promise<void> {
  const safe = ensureSafeFilename(fileName);
  if (!safe) {
    console.error(`${c.red}Invalid filename: ${fileName}${c.reset}`);
    process.exit(1);
  }
  const candidates = [join(pendingDir, safe), ...(await autoPendingPaths(safe))];
  for (const path of candidates) {
    try {
      await rm(path);
      console.log(`${c.dim}rejected ${safe}${c.reset}`);
      return;
    } catch {
      // Next candidate.
    }
  }
  console.error(`${c.red}No such pending skill: ${safe}${c.reset}`);
  process.exit(1);
}

/** E3 — enumerate per-personality auto-pending paths for the given filename. */
async function autoPendingPaths(safe: string): Promise<string[]> {
  const root = join(ethosDir(), 'skills', '.pending');
  try {
    const personalities = await readdir(root);
    return personalities.map((p) => join(root, p, safe));
  } catch {
    return [];
  }
}

function ensureSafeFilename(name: string): string | null {
  if (!name.endsWith('.md')) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}
