// `ethos learning` — the terminal half of the learning review inbox (plan
// `trust-before-reach.md` Part 4, L-T8).
//
//   ethos learning list [--personality <id>] [--all]
//   ethos learning show <id>
//   ethos learning replay <id>
//   ethos learning approve <id> [--override "<reason>"]
//   ethos learning reject <id> [--reason "<text>"]
//   ethos learning rollback <id> [--reason "<text>"]
//
// Every decision goes through `LearningInbox` (`extensions/learning-inbox/src/
// inbox.ts`), the same object the `learning.*` RPCs decide through. This file
// only parses arguments and prints; the override rule (a non-`pass` approval
// needs a reason) and the `learning.*` audit rows are the inbox's.
//
// `skills_pending_approve` (`extensions/tools-skills/src/index.ts`) refuses in
// chat and names `ethos learning approve <id>` — this is that command.

import type { EthosConfig } from '@ethosagent/config';
import {
  AWAITING_DECISION,
  type LearningCandidate,
  type LearningCandidateDetail,
  type LearningInbox,
  type ReplayReport,
} from '@ethosagent/wiring';
import { createCliLearningInbox } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

export interface LearningCliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: LearningCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const USAGE = [
  'Usage: ethos learning <command>',
  '',
  '  list [--personality <id>] [--all]      candidates waiting for a decision (--all: every status)',
  '  show <id>                              evidence, proposed content, replay scorecard, timeline',
  '  replay <id>                            replay now — a dry run on real models, costs money',
  '  approve <id> [--override "<reason>"]   promote it; a verdict other than pass needs a reason',
  '  reject <id> [--reason "<text>"]        discard it',
  '  rollback <id> [--reason "<text>"]      undo a promotion',
];

/** Flags that take a value, so the value is never mistaken for the positional id. */
const VALUE_FLAGS = new Set(['--override', '--reason', '--personality']);

export async function runLearning(args: string[], config: EthosConfig): Promise<void> {
  const inbox = await createCliLearningInbox(config);
  const code = await runLearningCommand(args, inbox);
  if (code !== 0) process.exitCode = code;
}

/** The command body, with the inbox and output injected. Returns the exit code. */
export async function runLearningCommand(
  args: readonly string[],
  inbox: LearningInbox,
  io: LearningCliIo = CONSOLE_IO,
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return list(rest, inbox, io);
    case 'show':
      return withId(rest, io, (id) => show(id, inbox, io));
    case 'replay':
      return withId(rest, io, (id) => replay(id, inbox, io));
    case 'approve':
      return withId(rest, io, (id) => approve(id, flagValue(rest, '--override'), inbox, io));
    case 'reject':
      return withId(rest, io, (id) => reject(id, flagValue(rest, '--reason'), inbox, io));
    case 'rollback':
      return withId(rest, io, (id) => rollback(id, flagValue(rest, '--reason'), inbox, io));
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      for (const line of USAGE) io.out(line);
      return 0;
    default:
      io.err(`${c.red}Unknown subcommand: ${sub}${c.reset}`);
      for (const line of USAGE) io.err(line);
      return 1;
  }
}

// --- Subcommands -------------------------------------------------------------

async function list(args: readonly string[], inbox: LearningInbox, io: LearningCliIo) {
  const personalityId = flagValue(args, '--personality');
  const candidates = await inbox.list({
    ...(personalityId ? { personalityId } : {}),
    ...(args.includes('--all') ? {} : { status: AWAITING_DECISION }),
  });
  if (candidates.length === 0) {
    io.out(
      `${c.dim}${args.includes('--all') ? 'No learning candidates.' : 'No learning candidates waiting for a decision.'}${c.reset}`,
    );
    return 0;
  }
  for (const line of table(
    ['ID', 'KIND', 'PERSONALITY', 'ORIGIN', 'STATUS', 'VERDICT', 'SUBMITTED'],
    candidates.map((x) => [
      x.id,
      kindLabel(x),
      x.personalityId,
      x.origin,
      x.status,
      x.verdict ?? 'not run',
      x.submittedAt,
    ]),
  )) {
    io.out(line);
  }
  return 0;
}

async function show(id: string, inbox: LearningInbox, io: LearningCliIo) {
  const result = await inbox.get(id);
  if (!result.ok) {
    io.err(`${c.red}${result.reason}${c.reset}`);
    return 1;
  }
  const d = result.value;
  const x = d.candidate;
  io.out(`${c.bold}Learning candidate ${x.id}${c.reset}`);
  io.out(`  kind:         ${kindLabel(x)} (${x.kind}/${x.op})`);
  io.out(`  personality:  ${x.personalityId}`);
  io.out(`  origin:       ${x.origin}`);
  io.out(`  status:       ${x.status}`);
  io.out(`  verdict:      ${x.verdict ?? 'not run'}`);
  io.out(`  destination:  ${x.destination}`);
  io.out(`  submitted:    ${x.submittedAt}`);

  io.out('');
  io.out(`${c.bold}Evidence${c.reset}`);
  if (x.evidence.ref) io.out(`  ref:       ${x.evidence.ref}`);
  if (x.evidence.sessionIds.length > 0) io.out(`  sessions:  ${x.evidence.sessionIds.join(', ')}`);
  if (x.evidence.taskIds.length > 0) io.out(`  tickets:   ${x.evidence.taskIds.join(', ')}`);
  if (x.evidence.digest) for (const line of x.evidence.digest.split('\n')) io.out(`  ${line}`);

  io.out('');
  io.out(
    `${c.bold}Proposed ${x.kind === 'expression' ? 'Expression' : 'skill file'}${c.reset}  ${c.dim}${d.current.content === null ? 'nothing is live at the destination' : 'replaces what is live at the destination'}${c.reset}`,
  );
  for (const line of x.content.replace(/\n$/, '').split('\n')) io.out(`  ${line}`);

  io.out('');
  printScorecard(d, io);

  if (x.status === 'promoted') {
    io.out('');
    io.out(
      d.rollback.allowed
        ? `${c.bold}Rollback${c.reset}  available — ethos learning rollback ${x.id}`
        : `${c.bold}Rollback${c.reset}  unavailable — ${d.rollback.reason}`,
    );
  }

  io.out('');
  io.out(`${c.bold}Timeline${c.reset}`);
  for (const e of d.timeline) {
    const move = e.from || e.to ? ` ${e.from ?? '·'} → ${e.to ?? '·'}` : '';
    const verdict = e.verdict ? ` [${e.verdict}]` : '';
    const who = e.actor ? ` by ${e.actor}` : '';
    const why = e.reason ? ` — ${e.reason}` : '';
    io.out(`  ${e.at}  ${e.action}${move}${verdict}${who}${why}`);
  }
  return 0;
}

async function replay(id: string, inbox: LearningInbox, io: LearningCliIo) {
  io.out(
    `${c.dim}Replaying ${id} — baseline and candidate dry runs on every selected case…${c.reset}`,
  );
  const result = await inbox.replay(id);
  if (!result.ok) {
    io.err(`${c.red}${result.reason}${c.reset}`);
    return 1;
  }
  const r = result.value;
  io.out(`${summaryLine(r.report)}`);
  if (r.promotion?.ok) {
    io.out(`${c.green}promoted${c.reset} automatically (pass, auto approval, personality-scoped)`);
  } else {
    const why = r.promotion && !r.promotion.ok ? r.promotion.reason : r.decision.reason;
    io.out(`${c.yellow}waiting for review${c.reset} — ${why ?? ''}`);
  }
  io.out(`${c.dim}Scorecard: ethos learning show ${id}${c.reset}`);
  return 0;
}

async function approve(
  id: string,
  overrideReason: string | undefined,
  inbox: LearningInbox,
  io: LearningCliIo,
) {
  const result = await inbox.approve(id, {
    actor: 'cli',
    decidedBy: 'ethos learning approve',
    ...(overrideReason !== undefined ? { override: { reason: overrideReason } } : {}),
  });
  if (!result.ok) {
    io.err(`${c.red}not approved${c.reset} ${id} — ${result.reason}`);
    if (result.code === 'override_required') {
      io.err(
        `${c.dim}Approve anyway with: ethos learning approve ${id} --override "<reason>"${c.reset}`,
      );
    }
    return 1;
  }
  io.out(`${c.green}approved${c.reset} ${id} → ${result.value.record.destination}`);
  if (overrideReason?.trim())
    io.out(`${c.dim}override recorded: ${overrideReason.trim()}${c.reset}`);
  return 0;
}

async function reject(
  id: string,
  reason: string | undefined,
  inbox: LearningInbox,
  io: LearningCliIo,
) {
  const result = await inbox.reject(id, {
    actor: 'cli',
    decidedBy: 'ethos learning reject',
    reason,
  });
  if (!result.ok) {
    io.err(`${c.red}not rejected${c.reset} ${id} — ${result.reason}`);
    return 1;
  }
  io.out(`${c.dim}rejected ${id}${c.reset}`);
  return 0;
}

async function rollback(
  id: string,
  reason: string | undefined,
  inbox: LearningInbox,
  io: LearningCliIo,
) {
  const result = await inbox.rollback(id, {
    actor: 'cli',
    decidedBy: 'ethos learning rollback',
    reason,
  });
  if (!result.ok) {
    io.err(`${c.red}not rolled back${c.reset} ${id} — ${result.reason}`);
    return 1;
  }
  io.out(`${c.green}rolled back${c.reset} ${id}`);
  return 0;
}

// --- Rendering ---------------------------------------------------------------

function printScorecard(d: LearningCandidateDetail, io: LearningCliIo): void {
  const report = d.replay;
  if (!report) {
    io.out(
      `${c.bold}Replay scorecard${c.reset}  not run — ethos learning replay ${d.candidate.id}`,
    );
    return;
  }
  io.out(
    `${c.bold}Replay scorecard${c.reset}  ${c.dim}run ${report.runId} (${d.replayRunIds.length} run${d.replayRunIds.length === 1 ? '' : 's'})${c.reset}`,
  );
  io.out(`  ${summaryLine(report)}`);
  if (report.stopReason) {
    io.out(
      `  ${c.yellow}stopped: ${report.stopReason}${report.error ? ` — ${report.error}` : ''}${c.reset}`,
    );
  }
  if (report.cases.length > 0) {
    for (const line of table(
      ['CASE', 'ROLE', 'SOURCE', 'BASELINE', 'CANDIDATE', 'Δ'],
      report.cases.map((k) => [
        k.caseId,
        k.role,
        k.source,
        score(k.baseline?.score),
        score(k.candidate?.score),
        k.delta === null ? '—' : signed(k.delta),
      ]),
    )) {
      io.out(`  ${line}`);
    }
  }
  for (const s of report.skipped) io.out(`  ${c.dim}skipped ${s.caseId}: ${s.reason}${c.reset}`);
  // L-D4: the caveat travels with the scorecard, so it is printed from it.
  io.out(`  ${c.bold}Limitations${c.reset}`);
  for (const limitation of report.limitations) io.out(`  - ${limitation}`);
}

/** "Pass · target +0.42 · regressions 0/5 · $0.31 of $0.50 · tested on scout". */
function summaryLine(r: ReplayReport): string {
  const verdict = r.verdict.charAt(0).toUpperCase() + r.verdict.slice(1);
  const target = r.targetMeanDelta === null ? 'target —' : `target ${signed(r.targetMeanDelta)}`;
  return [
    verdict,
    target,
    `regressions ${r.regressionsWorse}/${r.regressionCount}`,
    `$${r.costUsd.toFixed(2)} of $${r.maxCostUsd.toFixed(2)}`,
    'dry-run: tools stubbed',
    `tested on ${r.testedOn}`,
  ].join(' · ');
}

function kindLabel(x: Pick<LearningCandidate, 'kind' | 'op'>): string {
  if (x.kind === 'expression') return 'Expression';
  return x.op === 'rewrite' ? 'Skill rewrite' : 'New skill';
}

function score(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

// --- Arguments ---------------------------------------------------------------

async function withId(
  args: readonly string[],
  io: LearningCliIo,
  run: (id: string) => Promise<number>,
): Promise<number> {
  const id = positional(args);
  if (!id) {
    io.err(`${c.red}A candidate id is required.${c.reset} List them with: ethos learning list`);
    return 1;
  }
  return run(id);
}

/** `--flag value` or `--flag=value`. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function positional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}
