import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import {
  type EvolveApplyResult,
  type EvolveResult,
  loadEvolveConfig,
  runEvolveApply,
  runEvolveArchive,
  runEvolvePrune,
  runEvolveStatus,
  SkillEvolver,
  skillEvolutionEvolveOptions,
} from '@ethosagent/skill-evolver';
import {
  AWAITING_DECISION,
  type LearningInbox,
  learningSubmitPort,
  type PrivateChatSet,
  privateChatSetFrom,
  turnWasShared,
} from '@ethosagent/wiring';
import { refuseJson, type Say, sayFor, writeJson, writeJsonError } from '../json-output';
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

const USAGE_LINES = [
  'Usage:',
  '  ethos evolve status [--json]',
  '  ethos evolve run [--quiet] [--json]',
  '  ethos evolve apply <candidate-id | filename> | --all [--json]',
  '  ethos evolve prune [--older-than <days>] [--yes] [--json]   reject old waiting candidates',
  '  ethos evolve archive [--older-than <days>] [--json]',
  '  ethos evolve --eval-output <file.eval.jsonl> [--auto-approve] [--json]',
  '  ethos evolve --list-pending [--json]',
  '  ethos evolve --approve <candidate-id | filename> | --approve-all [--json]',
  '  ethos evolve --reject <candidate-id | filename> [--json]',
  '',
  '  apply, --approve, --reject and --list-pending act on the learning inbox.',
  '  They approve only a candidate whose replay passed; for any other, use',
  '  ethos learning approve <id> --override "<reason>".',
];

function printUsage(): void {
  for (const line of USAGE_LINES) console.log(line);
}

export async function runEvolve(args: string[], config: EthosConfig): Promise<void> {
  // New subcommand routing: status / run / apply
  const sub = args[0];
  const dir = ethosDir();
  const json = args.includes('--json');

  if (sub === 'status') {
    const status = await runEvolveStatus(args.slice(1), dir, await createCliLearningInbox(config), {
      quiet: json,
    });
    if (json) writeJson({ ok: true, ...status });
    return;
  }

  if (sub === 'apply') {
    const applied = await runEvolveApply(args.slice(1), await createCliLearningInbox(config), {
      quiet: json,
    });
    if (json) emitApply(applied, !args.includes('--all'));
    return;
  }

  if (sub === 'run') {
    await runEvolveRun(args.slice(1), config, dir, json);
    return;
  }

  if (sub === 'prune') {
    refuseJson(
      args,
      'ethos evolve prune asks for confirmation and cannot run with --json unless --yes is given',
      { unlessFlag: '--yes' },
    );
    const pruned = await runEvolvePrune(args.slice(1), await createCliLearningInbox(config), {
      quiet: json,
    });
    if (json) writeJson({ ok: true, ...pruned });
    return;
  }

  if (sub === 'archive') {
    const archived = await runEvolveArchive(args.slice(1), dir, { quiet: json });
    if (json) writeJson({ ok: true, ...archived });
    return;
  }

  // Legacy flag-based routing. The queue verbs are thin adapters over the
  // learning inbox (L-T8): `--approve` / `--approve-all` are `evolve apply`,
  // which approves only a passing candidate; `--reject` and `--list-pending`
  // act on waiting skill candidates of every origin, not `skills/pending/`.
  const opts = parseArgs(args);
  const skillsDir = join(dir, 'skills');

  if (opts.listPending) {
    await listPendingCandidates(await createCliLearningInbox(config), json);
    return;
  }

  if (opts.approveAll) {
    const applied = await runEvolveApply(['--all'], await createCliLearningInbox(config), {
      quiet: json,
    });
    if (json) emitApply(applied, false);
    return;
  }

  if (opts.approve) {
    const applied = await runEvolveApply([opts.approve], await createCliLearningInbox(config), {
      quiet: json,
    });
    if (json) emitApply(applied, true);
    return;
  }

  if (opts.reject) {
    await rejectCandidate(opts.reject, await createCliLearningInbox(config), json);
    return;
  }

  if (opts.evalOutput) {
    const summary = await runAnalyze(
      opts.evalOutput,
      config,
      skillsDir,
      opts.autoApprove,
      undefined,
      json,
    );
    if (json) writeJson({ ok: true, ...summary });
    return;
  }

  if (json) writeJsonError('INVALID_INPUT', USAGE_LINES.join('\n'));
  printUsage();
}

/** The one document for `apply` / `--approve` / `--approve-all`; a single refused ref is an error. */
function emitApply(applied: EvolveApplyResult, single: boolean): void {
  if (applied.failure) {
    writeJsonError(
      applied.failure.kind === 'usage' ? 'INVALID_INPUT' : 'NOT_FOUND',
      applied.failure.message,
    );
  }
  const refused = applied.refused[0];
  if (single && refused) {
    writeJsonError('INVALID_INPUT', `not approved ${refused.id} — ${refused.reason}`);
  }
  writeJson({ ok: true, approved: applied.approved, refused: applied.refused });
}

// ---------------------------------------------------------------------------
// ethos evolve run [--quiet]
// ---------------------------------------------------------------------------
// Generates an eval output file from recent sessions and runs the evolver
// against it. This is the cron-safe equivalent of `--eval-output` — it
// sources sessions from the SQLite session store rather than requiring the
// caller to supply a pre-baked eval file.

async function runEvolveRun(
  args: string[],
  config: EthosConfig,
  dir: string,
  json: boolean,
): Promise<void> {
  const quiet = args.includes('--quiet');
  const skillsDir = join(dir, 'skills');
  const noSessions = (): void => {
    if (json) writeJson({ ok: true, analyzed: false, reason: 'No sessions to analyze.' });
    else if (!quiet) console.log(`${c.dim}No sessions to analyze.${c.reset}`);
  };

  // Export recent sessions to a temporary eval file.
  // The SQLite session store doesn't expose a built-in eval exporter, so we
  // check whether there are any sessions at all via the DB file's presence.
  const sessionsDb = join(dir, 'sessions.db');
  try {
    await stat(sessionsDb);
  } catch {
    noSessions();
    return;
  }

  // Build a temporary eval file from the session DB.
  const tmpEvalPath = join(dir, `.evolver-run-${Date.now()}.eval.jsonl`);
  let wroteRecords = false;
  try {
    wroteRecords = await exportSessionsToEval(
      sessionsDb,
      tmpEvalPath,
      privateChatSetFrom(config.gateway?.privateChats),
    );
  } catch (err) {
    // Under --json an export failure is unexpected: it reaches index.ts's top-level catch.
    if (json) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (!quiet) console.error(`${c.red}Failed to export sessions:${c.reset} ${msg}`);
    return;
  }

  if (!wroteRecords) {
    noSessions();
    return;
  }

  try {
    const summary = await runAnalyze(tmpEvalPath, config, skillsDir, false, undefined, json);
    if (json) writeJson({ ok: true, analyzed: true, ...summary });
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
 *
 * Shared sessions are never exported (plan personality-memory-boundary G1-8):
 * the sessions active in the window are read first and judged by
 * `turnWasShared` (packages/core/src/chat-audience.ts — the sticky stamp in
 * `metadata`, a pre-upgrade group lane key honouring `privateChats`, or a
 * non-owner DM's D8 marker), and
 * only the remaining ids are passed to the message query, so a busy group
 * cannot use up the row cap either. Pinned by the shared-session cases in
 * `apps/ethos/src/commands/__tests__/evolve-export.test.ts`.
 */
export async function exportSessionsToEval(
  dbPath: string,
  outPath: string,
  privateChats?: PrivateChatSet,
): Promise<boolean> {
  // Dynamic import keeps SQLite out of the require graph for codepaths
  // that don't use `evolve run`.
  const { default: Database } = await import('@ethosagent/sqlite');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Fetch messages from the last 7 days across all private sessions.
    // JOIN sessions to get the key (messages only has session_id FK, not session_key).
    // LIMIT 2000 prevents loading the entire table into memory on busy installs.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const active = db
      .prepare(
        `SELECT DISTINCT s.id, s.key, s.metadata
           FROM sessions s
           JOIN messages m ON m.session_id = s.id
          WHERE m.timestamp >= ?`,
      )
      .all(cutoff) as Array<{ id: string; key: string; metadata: string | null }>;
    const privateIds = active
      .filter((s) => {
        const metadata = parseMetadata(s.metadata);
        // Unreadable metadata cannot prove the session was never stamped shared: fail closed.
        return metadata !== null && !turnWasShared({ key: s.key, metadata }, privateChats);
      })
      .map((s) => s.id);
    if (privateIds.length === 0) return false;

    const rows = db
      .prepare(
        `SELECT s.key AS session_key, m.role, m.content
           FROM messages m
           JOIN sessions s ON m.session_id = s.id
          WHERE m.timestamp >= ?
            AND m.session_id IN (SELECT value FROM json_each(?))
          ORDER BY m.timestamp ASC
          LIMIT 2000`,
      )
      .all(cutoff, JSON.stringify(privateIds)) as Array<{
      session_key: string;
      role: string;
      content: string;
    }>;

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

/** A `sessions.metadata` cell: `undefined` when empty, `null` when it is not a JSON object. */
function parseMetadata(raw: string | null): Record<string, unknown> | undefined | null {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** What `runAnalyze` found and submitted; the `--json` document of `evolve run` / `--eval-output`. */
export interface EvolveAnalyzeSummary {
  evalOutput: string;
  model: string;
  skillsAnalyzed: number;
  rewriteCandidates: number;
  newSkillCandidates: number;
  rewritesSubmitted: string[];
  newSkillsSubmitted: string[];
  skipped: EvolveResult['skipped'];
  candidateIds: string[];
  /** One entry per candidate replayed by `--auto-approve`. */
  replays: EvolveReplayOutcome[];
}

export interface EvolveReplayOutcome {
  id: string;
  verdict: string;
  promoted: boolean;
  /** Why it was not promoted; empty when it was. */
  reason: string;
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
  json = false,
): Promise<EvolveAnalyzeSummary> {
  const say = sayFor(json);
  try {
    await stat(evalOutput);
  } catch {
    if (json) writeJsonError('FILE_NOT_FOUND', `Cannot read eval output: ${evalOutput}`);
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

  say(
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
    // `scope`, `evolve_existing` and `model` from the personality the drafts belong to.
    ...skillEvolutionEvolveOptions(reg.get(personalityId)?.skill_evolution),
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

  say('');
  say(`${c.dim}skills analyzed:${c.reset} ${result.plan.skillStats.length}`);
  say(`${c.dim}rewrite candidates:${c.reset} ${result.plan.rewriteCandidates.length}`);
  say(`${c.dim}new-skill candidates:${c.reset} ${result.plan.newSkillCandidates.length}`);
  say('');

  if (result.rewritesSubmitted.length > 0) {
    say(`${c.green}rewrites submitted:${c.reset}`);
    for (const f of result.rewritesSubmitted) say(`  ${f}`);
  }
  if (result.newSkillsSubmitted.length > 0) {
    say(`${c.green}new skills submitted:${c.reset}`);
    for (const f of result.newSkillsSubmitted) say(`  ${f}`);
  }
  if (result.skipped.length > 0) {
    say(`${c.yellow}skipped:${c.reset}`);
    for (const s of result.skipped) say(`  ${s.kind} ${s.target} — ${s.reason}`);
  }
  const summary: EvolveAnalyzeSummary = {
    evalOutput,
    model: llm.model,
    skillsAnalyzed: result.plan.skillStats.length,
    rewriteCandidates: result.plan.rewriteCandidates.length,
    newSkillCandidates: result.plan.newSkillCandidates.length,
    rewritesSubmitted: result.rewritesSubmitted,
    newSkillsSubmitted: result.newSkillsSubmitted,
    skipped: result.skipped,
    candidateIds: result.candidateIds,
    replays: [],
  };
  if (
    result.rewritesSubmitted.length === 0 &&
    result.newSkillsSubmitted.length === 0 &&
    result.skipped.length === 0
  ) {
    say(`${c.dim}nothing to evolve.${c.reset}`);
    return summary;
  }

  if (autoApprove && result.candidateIds.length > 0) {
    say('');
    summary.replays = await replayEvolvedCandidates(config, reg, result.candidateIds, say);
    return summary;
  }

  say('');
  say(`Review with: ${c.bold}ethos learning list${c.reset}`);
  say(`Approve with: ${c.bold}ethos learning approve <id>${c.reset}`);
  return summary;
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
  say: Say = sayFor(false),
): Promise<EvolveReplayOutcome[]> {
  say(
    `${c.bold}--auto-approve${c.reset} replaying ${candidateIds.length} candidate(s) before anything goes live...`,
  );
  const replay = await createLearningReplayer(config, {
    personalities: reg,
    actor: 'evolve',
    autoApproveOverride: true,
  });
  const outcomes: EvolveReplayOutcome[] = [];
  for (const id of candidateIds) {
    const r = await replay(id);
    const why = r.promotion && !r.promotion.ok ? r.promotion.reason : (r.decision.reason ?? '');
    const outcome = r.promotion?.ok
      ? `${c.green}promoted${c.reset}`
      : `${c.yellow}waiting for review${c.reset} — ${why}`;
    say(`  ${id}: ${r.report.verdict} · ${outcome}`);
    outcomes.push({
      id,
      verdict: r.report.verdict,
      promoted: r.promotion?.ok === true,
      reason: r.promotion?.ok ? '' : why,
    });
  }
  return outcomes;
}

/** `--list-pending`: the learning inbox's waiting SKILL candidates, every origin (L-T8). */
async function listPendingCandidates(inbox: LearningInbox, json: boolean): Promise<void> {
  const waiting = await inbox.list({ kind: 'skill', status: AWAITING_DECISION });
  if (json) {
    writeJson({
      ok: true,
      count: waiting.length,
      candidates: waiting.map((x) => ({
        id: x.id,
        destination: x.destination,
        personalityId: x.personalityId,
        origin: x.origin,
        verdict: x.verdict ?? null,
      })),
    });
    return;
  }
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
async function rejectCandidate(ref: string, inbox: LearningInbox, json: boolean): Promise<void> {
  const found = await inbox.resolve(ref, { kind: 'skill' });
  if (!found.ok) {
    if (json) {
      writeJsonError(found.code === 'ambiguous' ? 'INVALID_INPUT' : 'NOT_FOUND', found.reason);
    }
    console.error(`${c.red}${found.reason}${c.reset}`);
    process.exit(1);
  }
  const result = await inbox.reject(found.value.id, {
    actor: 'cli',
    decidedBy: 'ethos evolve --reject',
  });
  if (!result.ok) {
    if (json) writeJsonError('INVALID_INPUT', result.reason);
    console.error(`${c.red}${result.reason}${c.reset}`);
    process.exit(1);
  }
  if (json) {
    writeJson({
      ok: true,
      id: found.value.id,
      destination: found.value.destination,
      rejected: true,
    });
    return;
  }
  console.log(
    `${c.dim}rejected ${found.value.id} (${basename(found.value.destination)})${c.reset}`,
  );
}
