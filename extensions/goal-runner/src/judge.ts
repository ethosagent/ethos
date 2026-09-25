import type { AcceptanceSpec, CriterionResult, Verdict } from '@ethosagent/types';

export interface JudgeInput {
  output: string;
  spec: AcceptanceSpec;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface JudgeOptions {
  /**
   * Runs a check's `command`. The judge has no shell of its own (S1, plan
   * openclaw-2026.9.6-gaps): production injects the executor
   * `createAcceptanceCheckExecutor` builds in packages/wiring, which refuses a
   * personality without `terminal`, applies the hardline, deny-rule and
   * approval checks the `terminal` tool's path crosses, and runs the command on
   * the personality's resolved execution backend. Absent → every command check
   * fails with {@link NO_EXECUTOR_EVIDENCE}; nothing runs.
   */
  execCommand?: (command: string) => Promise<CommandResult>;
}

const EVIDENCE_SNIPPET_CHARS = 200;

/** Why a command check failed when no executor was injected. */
export const NO_EXECUTOR_EVIDENCE = 'no execution backend is wired for command checks';

function snippet(text: string): string {
  return text.trim().slice(0, EVIDENCE_SNIPPET_CHARS);
}

function refuseCommand(): Promise<CommandResult> {
  return Promise.reject(new Error(NO_EXECUTOR_EVIDENCE));
}

async function runCommandCheck(
  check: { id: string; description: string; command: string },
  execCommand: (command: string) => Promise<CommandResult>,
): Promise<CriterionResult> {
  try {
    const { code, stdout, stderr } = await execCommand(check.command);
    if (code === 0) {
      const out = snippet(stdout);
      return {
        id: check.id,
        pass: true,
        evidence: out ? `command exited 0: ${out}` : 'command exited 0',
      };
    }
    const detail = snippet(stderr) || snippet(stdout);
    return {
      id: check.id,
      pass: false,
      evidence: detail ? `command exited ${code}: ${detail}` : `command exited ${code}`,
      gap: check.description,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: check.id,
      pass: false,
      evidence: `command failed: ${snippet(message)}`,
      gap: check.description,
    };
  }
}

/**
 * Run mechanical checks and score rubric items.
 * Checks with a `command` run it through `opts.execCommand` and pass iff it
 * exits 0 (a refusal or timeout fails the check with the reason as evidence);
 * commands run sequentially since they may touch shared state. Checks
 * without a command fall back to a substring match against the attempt output.
 * Rubric items still get placeholder scores — the eval-harness integration
 * (plan phase 2) replaces the rubric scoring.
 */
export async function judge(input: JudgeInput, opts?: JudgeOptions): Promise<Verdict> {
  const execCommand = opts?.execCommand ?? refuseCommand;
  const results: CriterionResult[] = [];

  for (const check of input.spec.checks) {
    const command = check.command;
    if (command) {
      results.push(await runCommandCheck({ ...check, command }, execCommand));
      continue;
    }
    const pass = input.output.toLowerCase().includes(check.description.toLowerCase());
    results.push({
      id: check.id,
      pass,
      evidence: pass ? `check passed: ${check.description}` : `check failed: ${check.description}`,
      gap: pass ? undefined : check.description,
    });
  }

  for (const rubric of input.spec.rubric) {
    const score = input.output.length > 0 ? 0.5 : 0;
    results.push({
      id: rubric.id,
      score,
      evidence: `rubric placeholder score: ${score}`,
      gap: score < input.spec.threshold ? rubric.description : undefined,
    });
  }

  const totalWeight = input.spec.rubric.reduce((sum, r) => sum + r.weight, 0);
  const weightedSum = input.spec.rubric.reduce((sum, r) => {
    const result = results.find((cr) => cr.id === r.id);
    return sum + (result?.score ?? 0) * r.weight;
  }, 0);
  const score = totalWeight > 0 ? weightedSum / totalWeight : 1;

  const allChecksPassed = input.spec.checks.every((c) => {
    const result = results.find((cr) => cr.id === c.id);
    return result?.pass === true;
  });

  return {
    score: allChecksPassed ? score : 0,
    perCriterion: results,
  };
}

export function isConverged(verdict: Verdict, threshold: number): boolean {
  const allChecksPassed = verdict.perCriterion
    .filter((c) => c.pass !== undefined)
    .every((c) => c.pass === true);
  return allChecksPassed && verdict.score >= threshold;
}
