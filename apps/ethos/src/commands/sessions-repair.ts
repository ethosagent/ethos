// `ethos sessions repair [--deep] [--apply] [--yes] [--json]` — thin CLI shim over
// the repair engine in `packages/wiring/src/sessions-repair/` (plan
// session-db-repair 5.2, 5.4). The engine returns reports and prints nothing; this
// file owns the flags, the prompt and the words an operator reads.
//
// Imports ONLY @ethosagent/wiring / @ethosagent/types / @ethosagent/config: a new
// app file may not reach an extension (archcheck l5-apps-through-wiring).
//
// Default is check mode (read-only: raw handle, query_only, no lock). `--apply`
// writes, and prompts unless `--yes`. Pinned by __tests__/sessions-repair.test.ts.

import { createInterface } from 'node:readline';
import { ethosDir } from '@ethosagent/config';
import { EthosError } from '@ethosagent/types';
import {
  diagnoseSessionsDb,
  repairSessionsDb,
  rowsSummary,
  type SessionsDbReport,
} from '@ethosagent/wiring';
import { writeJson, writeJsonError } from '../json-output';
import { FTS_DOWN_CONSEQUENCE } from '../lib/sessions-db-advice';
import { formatBytes } from './backup';

const FLAGS = new Set(['--deep', '--apply', '--yes', '-y', '--json']);

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export interface SessionsRepairDeps {
  dataDir?: string;
  /** Where human output goes; defaults to `console.log`. */
  out?: (line: string) => void;
  /** The `--apply` prompt; defaults to a readline `[y/N]` question. */
  confirm?: (question: string) => Promise<boolean>;
}

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

const CLASS_TEXT: Record<SessionsDbReport['classification'], { what: string; effect?: string }> = {
  ok: { what: 'ok' },
  fts: {
    what: 'fts  (the messages table is intact; the search index is not)',
    effect: FTS_DOWN_CONSEQUENCE,
  },
  index: {
    what: 'index  (a table index is damaged; the data pages are intact)',
    effect: 'Lookups through the damaged index can miss rows or fail.',
  },
  heap: {
    what: 'heap  (table data pages are damaged)',
    effect: 'Rows may be unreadable. This tool cannot repair table pages.',
  },
  unknown: {
    what: 'unknown  (the verdict matches no repairable pattern)',
    effect: 'This tool cannot repair it.',
  },
};

function printReport(r: SessionsDbReport, deep: boolean, say: (l: string) => void): void {
  say(`${c.bold}sessions.db${c.reset}  ${r.path}  (${formatBytes(r.sizeBytes)})`);
  const integrity = r.integrity.ok
    ? `${c.green}ok${c.reset}`
    : `${c.red}FAILED${c.reset}  ${c.dim}${(r.integrity.detail ?? '').split('\n')[0]}${c.reset}`;
  say(`  integrity_check          ${integrity}`);
  const drift = r.fts.unindexed + r.fts.dangling > 0;
  say(
    `  FTS drift (docsize)      ${drift ? c.yellow : ''}unindexed ${r.fts.unindexed} · dangling ${r.fts.dangling}${drift ? c.reset : ''}`,
  );
  if (deep) {
    const d = r.fts.deep;
    say(
      `  FTS deep check           ${
        d === null
          ? `${c.dim}not run${c.reset}`
          : d.ok
            ? `${c.green}ok${c.reset}`
            : `${c.red}FAILED${c.reset}  ${c.dim}${d.detail ?? ''}${c.reset}`
      }`,
    );
  }
  const bad = rowsSummary(r.rows) !== 'none';
  say(
    `  malformed rows           ${bad ? c.yellow : ''}${rowsSummary(r.rows)}${bad ? c.reset : ''}`,
  );
  for (const w of r.warnings) say(`  ${c.dim}note: ${w}${c.reset}`);
  if (!r.integrity.ok && (r.integrity.detail ?? '').includes('\n')) {
    for (const line of (r.integrity.detail ?? '').split('\n').slice(1)) {
      say(`    ${c.dim}${line}${c.reset}`);
    }
  }

  const cls = CLASS_TEXT[r.classification];
  if (r.classification === 'ok') {
    if (bad) {
      say(
        `Class: ok  ${c.dim}(malformed rows are read in degraded form; there is nothing to repair automatically)${c.reset}`,
      );
    } else {
      say(`${c.green}✓${c.reset} sessions.db is healthy.`);
    }
    return;
  }
  say(`Class: ${cls.what}`);
  if (cls.effect) say(`Effect: ${cls.effect}`);
  if (r.plan.length > 0) {
    const steps = r.plan
      .map((a) => (a === 'rebuild_fts' ? 'rebuild messages_fts' : 'REINDEX'))
      .join(', then ');
    say(
      `Plan:   ${steps}, after a verbatim copy to ${r.path.replace(/sessions\.db$/, '')}.pre-repair/<...>/`,
    );
    say(`Run:    ${c.bold}ethos sessions repair --apply${c.reset}`);
  } else {
    say(`Plan:   none. Restore from a backup: ${c.bold}ethos import <archive>${c.reset}`);
  }
}

function usageError(message: string): EthosError {
  return new EthosError({
    code: 'INVALID_INPUT',
    cause: message,
    action: 'Usage: ethos sessions repair [--deep] [--apply] [--yes] [--json]',
  });
}

/**
 * Expected failures: under `--json` one `{ok:false,error}` document and exit 1
 * (`writeJsonError`, like every other `--json` command); otherwise the
 * `EthosError` is thrown for the top-level handler's human block.
 */
function fail(json: boolean, err: EthosError): never {
  if (json) writeJsonError(err.code, err.cause);
  throw err;
}

/**
 * Run the command; returns the exit code (0 healthy or repaired+verified, 1
 * findings / failed verification / a declined `--apply` on a damaged file).
 * Refusals throw `EthosError`, or emit a JSON error document under `--json`.
 */
export async function runSessionsRepair(
  argv: string[],
  deps: SessionsRepairDeps = {},
): Promise<number> {
  const json = argv.includes('--json');
  for (const a of argv) {
    if (!FLAGS.has(a)) fail(json, usageError(`Unknown option for sessions repair: ${a}`));
  }
  const deep = argv.includes('--deep');
  const apply = argv.includes('--apply');
  const yes = argv.includes('--yes') || argv.includes('-y');
  if (json && apply && !yes) {
    fail(json, usageError('--json with --apply cannot prompt; pass --yes to confirm.'));
  }
  const dataDir = deps.dataDir ?? ethosDir();
  const say = deps.out ?? ((line: string) => console.log(line));
  const confirm = deps.confirm ?? askYesNo;

  const checked = await diagnoseSessionsDb(dataDir, { deep });

  if (!apply) {
    if (json) writeJson(checked);
    else if (!checked.exists) say('No sessions.db yet; nothing to check.');
    else printReport(checked, deep, say);
    return checked.ok ? 0 : 1;
  }

  if (!checked.exists) {
    if (json) writeJson(checked);
    else say('No sessions.db yet; nothing to repair.');
    return 0;
  }
  if (checked.classification === 'heap' || checked.classification === 'unknown') {
    fail(
      json,
      new EthosError({
        code: 'DB_CORRUPT',
        cause: `sessions.db is damaged beyond what this tool repairs (${checked.classification}): ${checked.integrity.detail?.split('\n')[0] ?? 'integrity_check failed'}`,
        action: 'restore from a backup: ethos import <archive>',
        details: { classification: checked.classification, path: checked.path },
      }),
    );
  }
  if (checked.plan.length === 0) {
    if (json) writeJson(checked);
    else printReport(checked, deep, say);
    return checked.ok ? 0 : 1;
  }

  if (!json) printReport(checked, deep, say);
  if (!yes) {
    const go = await confirm('Repair sessions.db now? A verbatim copy is taken first. [y/N] ');
    if (!go) {
      say('Cancelled.');
      return 1; // findings exist and nothing was repaired: still damaged
    }
  }

  // The gate-time re-inspection reuses this diagnosis' row scan and deep check.
  let done: SessionsDbReport;
  try {
    done = await repairSessionsDb(dataDir, {
      deep,
      prior: { rows: checked.rows, deep: checked.fts.deep },
    });
  } catch (err) {
    if (json && err instanceof EthosError) fail(json, err);
    throw err;
  }
  const applied = done.applied;
  if (json) {
    writeJson(done);
  } else if (applied) {
    if (applied.verified) {
      say(
        `${c.green}✓${c.reset} Repaired (${applied.actions.join(', ') || 'no change'}) and verified in ${applied.durationMs} ms.`,
      );
    } else {
      say(
        `${c.red}✗${c.reset} Repair ran but sessions.db did not verify clean (integrity_check or FTS drift still failing).`,
      );
    }
    if (applied.copy) say(`  Pre-repair copy (verbatim): ${applied.copy}`);
  }
  return applied?.verified ? 0 : 1;
}
