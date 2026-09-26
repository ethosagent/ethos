// The gate that makes architecture.config.ts fail a build.
//
// archcheck (npm `archcheck`) is the repository's architecture checker: the layer model of
// ARCHITECTURE.md §II, the laws of §III it can see syntactically, and the §VIII exceptions, all
// declared once in architecture.config.ts. This file runs it through its API against the real
// repository so a violation fails `pnpm test` — and therefore `pnpm check` and CI's `tests` job —
// with every finding printed as rule id, file:line, statement and remedy.
//
// Reading a failure — the exit code is archcheck's `exitCodeFor`:
//   1  a new violation of an error rule. Fix the code, or (rarely) record a §VIII exception in
//      architecture.config.ts with an owner, an expiry and a removal condition.
//   2  the manifest or the environment is broken (it did not load, or an exception has expired).
//      Fix architecture.config.ts, not the code.
//   4  a baselined finding no longer reproduces — something got fixed. Run
//      `pnpm exec archcheck baseline --prune` and commit the smaller .archcheck/baseline.json.
//
// That each rule can fire at all is proven separately, by archcheck-fixtures.test.ts.
//
// It lives beside architecture-rules.test.ts (the scripts/check-architecture.mjs harness) because
// it is the same kind of thing: a mechanical check on a rule the constitution states in prose.

import { join } from 'node:path';
import { type Diagnostic, exitCodeFor, load } from 'archcheck';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

// A cold run over the whole repository takes ~35s (a full TypeScript program build); a warm one,
// with .archcheck/cache populated, ~7s.
const COLD_RUN_MS = 120_000;

function describeFinding(d: Diagnostic): string {
  const lines = d.occurrenceLines?.length
    ? d.occurrenceLines
    : d.line === undefined
      ? []
      : [d.line];
  const where = lines.length > 0 ? `${d.file}:${lines.join(',')}` : d.file;
  return `  ${d.ruleId}  ${where}\n    ${d.statement}\n    → ${d.remedy.summary}`;
}

describe('archcheck against the real repository', () => {
  it(
    'exits 0: no new violation, no expired exception, no stale baseline entry',
    async () => {
      const loaded = load({ cwd: REPO_ROOT });
      if (!loaded.ok) {
        throw new Error(
          `archcheck exit 2 — architecture.config.ts did not load:\n${loaded.error.join('\n')}`,
        );
      }
      const run = await loaded.value.check();
      if (!run.ok) throw new Error(`archcheck exit 2 — the run failed:\n${run.error.join('\n')}`);
      const result = run.value;
      const code = exitCodeFor(result);
      if (code === 0) return;

      const failing = result.diagnostics.filter(
        (d) => d.severity === 'error' && !d.baselined && !d.exempted,
      );
      const expired = result.exceptions.filter((e) => e.expired);
      const report = [
        `archcheck exit ${code}`,
        ...(expired.length > 0
          ? [
              'expired exceptions (exit 2 — renew or remove in architecture.config.ts):',
              ...expired.map((e) => `  ${e.ruleId}  owner ${e.owner}, expired ${e.expires}`),
            ]
          : []),
        ...(result.baselineStale.length > 0
          ? [
              'stale baseline entries (exit 4 — run `pnpm exec archcheck baseline --prune`):',
              ...result.baselineStale.map((e) => `  ${e.ruleId}  ${e.identity}`),
            ]
          : []),
        ...(failing.length > 0
          ? [`${failing.length} new violation(s):`, ...failing.map(describeFinding)]
          : []),
      ].join('\n');
      expect.fail(report);
    },
    COLD_RUN_MS,
  );
});
