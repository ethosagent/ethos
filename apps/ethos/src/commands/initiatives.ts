import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { InitiativeRunner, RunReport } from '@ethosagent/initiative-runner';
import { EthosError } from '@ethosagent/types';
import { createInitiativeCliPort } from '@ethosagent/wiring';
import { type Say, sayFor, splitJson, writeJson } from '../json-output';
import { MANAGE_COMMANDS, runManageCommand } from '../lib/initiatives-manage';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { createAgentLoop, getStorage } from '../wiring';

// ethos initiatives run <id> --survey
// ethos initiatives run <id> --explore <EXP-id>
// ethos initiatives run <id> --scan
// ethos initiatives list | show | export | pause | resume | metrics | approve | deny | adopt | ...
//   (lib/initiatives-manage.ts)
//
// One read-only survey or window now (plan Task 5.1). It prints the window's tools, reads,
// findings and cost, then exits. There is no schedule yet and nothing here approves a proposal:
// `--explore` runs only an exploration the owner already approved.

const USAGE =
  'Usage: ethos initiatives (run <initiative-id> (--survey | --scan | --explore <EXP-id>) | list | show | export | pause | resume | metrics | approve | deny | adopt | dig-deeper | park | keep | stop | make-mine) [--json]';

const usageError = (cause: string): EthosError =>
  new EthosError({ code: 'INVALID_INPUT', cause, action: USAGE });

export type RunRequest =
  | { kind: 'survey'; initiativeId: string }
  | { kind: 'scan'; initiativeId: string }
  | { kind: 'window'; initiativeId: string; explorationId: string };

export function parseRunArgs(args: readonly string[]): RunRequest {
  const [sub, ...rest] = args;
  if (sub !== 'run') throw usageError(sub ? `unknown subcommand "${sub}"` : 'missing subcommand');
  const initiativeId = rest.find((a) => !a.startsWith('-'));
  if (!initiativeId) throw usageError('missing initiative id');
  const survey = rest.includes('--survey');
  const scan = rest.includes('--scan');
  const at = rest.indexOf('--explore');
  if (Number(survey) + Number(scan) + Number(at !== -1) !== 1) {
    throw usageError('pass exactly one of --survey, --scan or --explore');
  }
  if (survey) return { kind: 'survey', initiativeId };
  if (scan) return { kind: 'scan', initiativeId };
  const explorationId = rest[at + 1];
  if (!explorationId || explorationId.startsWith('-')) {
    throw usageError('--explore needs an exploration id');
  }
  return { kind: 'window', initiativeId, explorationId };
}

function printReport(report: RunReport, say: Say): void {
  const list = (items: readonly string[]) => (items.length ? items.join(', ') : 'none');
  say(`${report.kind} ${report.windowId} for ${report.initiativeId}: ended (${report.endReason})`);
  say(`  tools:  ${list(report.toolsUsed)}`);
  say(`  reads:  ${report.reads.length}`);
  for (const r of report.reads) say(`    ${r}`);
  if (report.kind === 'survey' || report.kind === 'scan') {
    say(`  proposed explorations: ${report.proposals.length}`);
    for (const p of report.proposals) say(`    ${p.id}  ${p.question}`);
    for (const x of report.started) say(`  started ${x.explorationId}: ${x.reason}`);
    for (const x of report.waiting) say(`  waiting ${x.explorationId}: ${x.reason}`);
  } else if (report.outcome) {
    say(`  exploration ${report.explorationId}: ${report.outcome}`);
  }
  say(`  findings: ${report.findings.length}`);
  for (const f of report.findings) say(`    ${f.id}  ${f.claim} [${f.sourceRef}]`);
  say(`  cost: $${report.spentUsd.toFixed(4)}`);
  if (report.error) say(`  note: ${report.error}`);
}

/** Parse, run, print. Throws `EthosError` for bad input or an unknown initiative. */
export async function runInitiativesCommand(
  args: readonly string[],
  runner: InitiativeRunner,
  opts: { json?: boolean } = {},
): Promise<RunReport> {
  const req = parseRunArgs(args);
  const report =
    req.kind === 'survey'
      ? await runner.runSurvey(req.initiativeId)
      : req.kind === 'scan'
        ? await runner.runScan(req.initiativeId)
        : await runner.runWindow(req.initiativeId, req.explorationId);
  if (opts.json) writeJson({ ok: true, ...report });
  else printReport(report, sayFor(false));
  return report;
}

export async function runInitiatives(argv: string[], config: EthosConfig): Promise<void> {
  const { json, args } = splitJson(argv);
  if (args[0] !== 'run') {
    // Everything but `run` reads or decides on the ledger; no loop, no LLM (and no db is created).
    if (!args[0] || !MANAGE_COMMANDS.includes(args[0])) {
      throw usageError(args[0] ? `unknown subcommand "${args[0]}"` : 'missing subcommand');
    }
    const port = await createInitiativeCliPort({ storage: getStorage(), dataDir: ethosDir() });
    try {
      const out = await runManageCommand(args, port, { personalityId: config.personality });
      if (out.raw !== undefined && !json) process.stdout.write(out.raw);
      else if (json) writeJson({ ok: true, ...out.data });
      else for (const line of out.lines) console.log(line);
    } finally {
      port?.close();
    }
    return;
  }
  // Reject bad input before building a runtime (an LLM client, the stores).
  parseRunArgs(args);
  const runtime = await createAgentLoop(config);
  try {
    await runInitiativesCommand(args, runtime.initiativeRunner, { json });
  } finally {
    await releaseCommandRuntime(runtime, { drainMs: 0 });
  }
}
