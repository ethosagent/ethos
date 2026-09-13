import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import {
  loadEvolveConfig,
  runEvolveApply,
  runEvolveArchive,
  runEvolvePrune,
  runEvolveStatus,
  SkillEvolver,
} from '@ethosagent/skill-evolver';
import { AWAITING_DECISION, type LearningInbox, learningSubmitPort } from '@ethosagent/wiring';
import { createCliLearningInbox, createLearningReplayer, createLLM, getStorage } from '../wiring';

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
  console.log('  ethos evolve apply <candidate-id | filename> | --all');
  console.log('  ethos evolve prune [--older-than <days>] [--yes]   reject old waiting candidates');
  console.log('  ethos evolve archive [--older-than <days>]');
  console.log('  ethos evolve --eval-output <file.eval.jsonl> [--auto-approve]');
  console.log('  ethos evolve --list-pending');
  console.log('  ethos evolve --approve <candidate-id | filename> | --approve-all');
  console.log('  ethos evolve --reject <candidate-id | filename>');
  console.log('');
  console.log('  apply, --approve, --reject and --list-pending act on the learning inbox.');
  console.log('  They approve only a candidate whose replay passed; for any other, use');
  console.log('  ethos learning approve <id> --override "<reason>".');
}

export async function runEvolve(args: string[], config: EthosConfig): Promise<void> {
  // New subcommand routing: status / run / apply
  const sub = args[0];
  const dir = ethosDir();

  if (sub === 'status') {
    await runEvolveStatus(args.slice(1), dir, await createCliLearningInbox(config));
    return;
  }

  if (sub === 'apply') {
    await runEvolveApply(args.slice(1), await createCliLearningInbox(config));
    return;
  }

  if (sub === 'run') {
    await runEvolveRun(args.slice(1), config, dir);
    return;
  }

  if (sub === 'prune') {
    await runEvolvePrune(args.slice(1), await createCliLearningInbox(config));
    return;
  }

  if (sub === 'archive') {
    await runEvolveArchive(args.slice(1), dir);
    return;
  }

  // Legacy flag-based routing. The queue verbs are thin adapters over the
  // learning inbox (L-T8): `--approve` / `--approve-all` are `evolve apply`,
  // which approves only a passing candidate; `--reject` and `--list-pending`
  // act on waiting skill candidates of every origin, not `skills/pending/`.
  const opts = parseArgs(args);
  const skillsDir = join(dir, 'skills');

  if (opts.listPending) {
    await listPendingCandidates(await createCliLearningInbox(config));
    return;
  }

  if (opts.approveAll) {
    await runEvolveApply(['--all'], await createCliLearningInbox(config));
    return;
  }

  if (opts.approve) {
    await runEvolveApply([opts.approve], await createCliLearningInbox(config));
    return;
  }

  if (opts.reject) {
    await rejectCandidate(opts.reject, await createCliLearningInbox(config));
    return;
  }

  if (opts.evalOutput) {
    await runAnalyze(opts.evalOutput, config, skillsDir, opts.autoApprove);
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
    await runAnalyze(tmpEvalPath, config, skillsDir, false);
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
  // Dynamic import keeps SQLite out of the require graph for codepaths
  // that don't use `evolve run`.
  const { default: Database } = await import('@ethosagent/sqlite');
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

/**
 * Path 7 (plan `trust-before-reach.md` Part 4). The evolver's drafts are
 * submitted to the learning inbox for the configured default personality.
 * `--auto-approve` no longer renames them into the live dir: it replays each
 * candidate here, synchronously (L-D9), and a candidate goes live only when
 * `replayAndResolve` allows it — a `pass` verdict, an `auto` answer from the
 * resolver (the flag stands in for the global `autoApprove` knob), and a
 * personality-scoped destination (L-D11).
 */
export async function runAnalyze(
  evalOutput: string,
  config: EthosConfig,
  skillsDir: string,
  autoApprove: boolean,
  targetCaseIds?: (tasks: import('@ethosagent/skill-evolver').TaskSummary[]) => Promise<string[]>,
): Promise<void> {
  try {
    await stat(evalOutput);
  } catch {
    console.error(`${c.red}Cannot read eval output: ${evalOutput}${c.reset}`);
    process.exit(1);
  }

  await mkdir(skillsDir, { recursive: true });

  const evolveConfig = await loadEvolveConfig(join(ethosDir(), 'evolve-config.json'), getStorage());
  const llm = await createLLM(config);
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const reg = await createPersonalityRegistry({
    storage: getStorage(),
    userPersonalitiesDir: ethosDir(),
  });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));
  const personalityId = config.personality;

  console.log(
    `${c.bold}ethos evolve${c.reset}  ${c.dim}eval: ${evalOutput} · model: ${llm.model}${c.reset}`,
  );

  const evolver = new SkillEvolver({
    evalOutputPath: evalOutput,
    skillsDir,
    config: evolveConfig,
    llm,
    storage: getStorage(),
    learning: learningSubmitPort({ storage: getStorage(), dataDir: ethosDir() }),
    dataDir: ethosDir(),
    personalityId,
    scope: reg.get(personalityId)?.skill_evolution?.scope,
    ...(targetCaseIds ? { targetCaseIds } : {}),
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
    rewritesProposed: result.rewritesSubmitted.length,
    newSkillsProposed: result.newSkillsSubmitted.length,
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

  if (result.rewritesSubmitted.length > 0) {
    console.log(`${c.green}rewrites submitted:${c.reset}`);
    for (const f of result.rewritesSubmitted) console.log(`  ${f}`);
  }
  if (result.newSkillsSubmitted.length > 0) {
    console.log(`${c.green}new skills submitted:${c.reset}`);
    for (const f of result.newSkillsSubmitted) console.log(`  ${f}`);
  }
  if (result.skipped.length > 0) {
    console.log(`${c.yellow}skipped:${c.reset}`);
    for (const s of result.skipped) console.log(`  ${s.kind} ${s.target} — ${s.reason}`);
  }
  if (
    result.rewritesSubmitted.length === 0 &&
    result.newSkillsSubmitted.length === 0 &&
    result.skipped.length === 0
  ) {
    console.log(`${c.dim}nothing to evolve.${c.reset}`);
    return;
  }

  if (autoApprove && result.candidateIds.length > 0) {
    console.log('');
    await replayEvolvedCandidates(config, reg, result.candidateIds);
    return;
  }

  console.log('');
  console.log(`Review with: ${c.bold}ethos learning list${c.reset}`);
  console.log(`Approve with: ${c.bold}ethos learning approve <id>${c.reset}`);
}

/**
 * `--auto-approve` on `ethos evolve` and `ethos eval --evolve`: replay each
 * candidate now and print what `replayAndResolve` decided. Nothing is renamed
 * into the live dir by this command any more.
 */
export async function replayEvolvedCandidates(
  config: EthosConfig,
  reg: import('@ethosagent/personalities').FilePersonalityRegistry,
  candidateIds: readonly string[],
): Promise<void> {
  console.log(
    `${c.bold}--auto-approve${c.reset} replaying ${candidateIds.length} candidate(s) before anything goes live...`,
  );
  const replay = await createLearningReplayer(config, {
    personalities: reg,
    actor: 'evolve',
    autoApproveOverride: true,
  });
  for (const id of candidateIds) {
    const r = await replay(id);
    const outcome = r.promotion?.ok
      ? `${c.green}promoted${c.reset}`
      : `${c.yellow}waiting for review${c.reset} — ${r.promotion && !r.promotion.ok ? r.promotion.reason : (r.decision.reason ?? '')}`;
    console.log(`  ${id}: ${r.report.verdict} · ${outcome}`);
  }
}

/** `--list-pending`: the learning inbox's waiting SKILL candidates, every origin (L-T8). */
async function listPendingCandidates(inbox: LearningInbox): Promise<void> {
  const waiting = await inbox.list({ kind: 'skill', status: AWAITING_DECISION });
  if (waiting.length === 0) {
    console.log(`${c.dim}No skill candidates waiting.${c.reset}`);
    return;
  }
  console.log(
    `${c.bold}Skill candidates waiting${c.reset}  ${c.dim}learning inbox — \`ethos learning list\` shows every kind${c.reset}`,
  );
  for (const candidate of waiting) {
    console.log(
      `  ${candidate.id}  ${basename(candidate.destination)}  ${c.dim}${candidate.personalityId} · ${candidate.origin} · ${candidate.verdict ?? 'not run'}${c.reset}`,
    );
  }
}

/** `--reject <candidate-id | filename>`: a human rejection through the inbox. */
async function rejectCandidate(ref: string, inbox: LearningInbox): Promise<void> {
  const found = await inbox.resolve(ref, { kind: 'skill' });
  if (!found.ok) {
    console.error(`${c.red}${found.reason}${c.reset}`);
    process.exit(1);
  }
  const result = await inbox.reject(found.value.id, {
    actor: 'cli',
    decidedBy: 'ethos evolve --reject',
  });
  if (!result.ok) {
    console.error(`${c.red}${result.reason}${c.reset}`);
    process.exit(1);
  }
  console.log(
    `${c.dim}rejected ${found.value.id} (${basename(found.value.destination)})${c.reset}`,
  );
}
