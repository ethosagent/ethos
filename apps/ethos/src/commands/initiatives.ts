import type { EthosConfig } from '@ethosagent/config';
import type { InitiativeRunner, RunReport } from '@ethosagent/initiative-runner';
import { EthosError } from '@ethosagent/types';
import { type Say, sayFor, splitJson, writeJson } from '../json-output';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { createAgentLoop } from '../wiring';

// ethos initiatives run <id> --survey
// ethos initiatives run <id> --explore <EXP-id>
//
// One read-only survey or window now (plan Task 5.1). It prints the window's tools, reads,
// findings and cost, then exits. There is no schedule yet and nothing here approves a proposal:
// `--explore` runs only an exploration the owner already approved.

const USAGE =
  'Usage: ethos initiatives run <initiative-id> (--survey | --explore <EXP-id>) [--json]';

const usageError = (cause: string): EthosError =>
  new EthosError({ code: 'INVALID_INPUT', cause, action: USAGE });

export type RunRequest =
  | { kind: 'survey'; initiativeId: string }
  | { kind: 'window'; initiativeId: string; explorationId: string };

export function parseRunArgs(args: readonly string[]): RunRequest {
  const [sub, ...rest] = args;
  if (sub !== 'run') throw usageError(sub ? `unknown subcommand "${sub}"` : 'missing subcommand');
  const initiativeId = rest.find((a) => !a.startsWith('-'));
  if (!initiativeId) throw usageError('missing initiative id');
  const survey = rest.includes('--survey');
  const at = rest.indexOf('--explore');
  if (survey === (at !== -1)) throw usageError('pass exactly one of --survey or --explore');
  if (survey) return { kind: 'survey', initiativeId };
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
  if (report.kind === 'survey') {
    say(`  proposed explorations: ${report.proposals.length}`);
    for (const p of report.proposals) say(`    ${p.id}  ${p.question}`);
    for (const x of report.started) say(`  started ${x.explorationId}: ${x.reason}`);
    for (const x of report.waiting) say(`  waiting ${x.explorationId}: ${x.reason}`);
  } else if (report.outcome) {
    say(
      `  exploration ${report.explorationId}: ${report.outcome}${report.reopened ? ' (reopened)' : ''}`,
    );
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
      : await runner.runWindow(req.initiativeId, req.explorationId);
  if (opts.json) writeJson({ ok: true, ...report });
  else printReport(report, sayFor(false));
  return report;
}

export async function runInitiatives(argv: string[], config: EthosConfig): Promise<void> {
  const { json, args } = splitJson(argv);
  // Reject bad input before building a runtime (an LLM client, the stores).
  parseRunArgs(args);
  const runtime = await createAgentLoop(config);
  try {
    await runInitiativesCommand(args, runtime.initiativeRunner, { json });
  } finally {
    await releaseCommandRuntime(runtime, { drainMs: 0 });
  }
}
