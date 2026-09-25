import { execFile } from 'node:child_process';
import type { AcceptanceCheck, AcceptanceSpec, CriterionResult, Verdict } from '@ethosagent/types';

export interface JudgeInput {
  output: string;
  spec: AcceptanceSpec;
  /** The goal text, handed to `judgeCheck` so it can read a check in context. */
  goalText?: string;
}

export interface CheckJudgeInput {
  check: AcceptanceCheck;
  goalText: string;
  output: string;
}

export interface CheckJudgeResult {
  pass: boolean;
  evidence: string;
}

/**
 * Decides whether an attempt's output demonstrates a command-less check is MET.
 * Injected at construction (`GoalRunnerConfig.judgeCheck`); production wiring
 * binds `createLLMCheckJudge` (./llm-check-judge). A throw is a fail-closed
 * `pass: false` in `judge()` below, never an exception out of it.
 */
export type CheckJudge = (input: CheckJudgeInput) => Promise<CheckJudgeResult>;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface JudgeOptions {
  /** Override command execution (tests). Defaults to running via `sh -c`. */
  execCommand?: (command: string) => Promise<CommandResult>;
  /**
   * Judge for checks with no `command`. Absent (tests, standalone), such a
   * check falls back to a verbatim substring match of its description against
   * the output, marked `method: 'substring'`.
   */
  judgeCheck?: CheckJudge;
}

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const EVIDENCE_SNIPPET_CHARS = 200;

function snippet(text: string): string {
  return text.trim().slice(0, EVIDENCE_SNIPPET_CHARS);
}

/** Run a check command via `sh -c` with a 30s timeout. Rejects on timeout or spawn failure. */
function defaultExecCommand(command: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'sh',
      ['-c', command],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, cwd: process.cwd() },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        // Timeout (killed) or spawn failure — there is no usable exit code.
        reject(new Error(error.killed ? `timed out after ${COMMAND_TIMEOUT_MS}ms` : error.message));
      },
    );
  });
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
        method: 'command',
      };
    }
    const detail = snippet(stderr) || snippet(stdout);
    return {
      id: check.id,
      pass: false,
      evidence: detail ? `command exited ${code}: ${detail}` : `command exited ${code}`,
      gap: check.description,
      method: 'command',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: check.id,
      pass: false,
      evidence: `command failed: ${snippet(message)}`,
      gap: check.description,
      method: 'command',
    };
  }
}

/** Settle a command-less check through the injected judge. Fails CLOSED: a
 *  judge that throws (provider error, timeout) is a failed check, not a pass. */
async function runJudgedCheck(
  check: AcceptanceCheck,
  goalText: string,
  output: string,
  judgeCheck: CheckJudge,
): Promise<CriterionResult> {
  let pass: boolean;
  let evidence: string;
  try {
    ({ pass, evidence } = await judgeCheck({ check, goalText, output }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pass = false;
    evidence = `judge unavailable: ${snippet(message)}`;
  }
  return {
    id: check.id,
    pass,
    evidence,
    ...(pass ? {} : { gap: check.description }),
    method: 'llm',
  };
}

/**
 * Run mechanical checks and score rubric items.
 * Checks with a `command` execute it via `sh -c` (30s timeout) and pass iff it
 * exits 0; commands run sequentially since they may touch shared state. Checks
 * without a command go to the injected `judgeCheck` (fail-closed); without one
 * they fall back to a substring match against the attempt output, marked
 * `method: 'substring'`.
 * Rubric items still get placeholder scores — the eval-harness integration
 * (plan phase 2) replaces the rubric scoring.
 */
export async function judge(input: JudgeInput, opts?: JudgeOptions): Promise<Verdict> {
  const execCommand = opts?.execCommand ?? defaultExecCommand;
  const results: CriterionResult[] = [];

  for (const check of input.spec.checks) {
    const command = check.command;
    if (command) {
      results.push(await runCommandCheck({ ...check, command }, execCommand));
      continue;
    }
    if (opts?.judgeCheck) {
      results.push(
        await runJudgedCheck(check, input.goalText ?? '', input.output, opts.judgeCheck),
      );
      continue;
    }
    const pass = input.output.toLowerCase().includes(check.description.toLowerCase());
    results.push({
      id: check.id,
      pass,
      evidence: pass ? `check passed: ${check.description}` : `check failed: ${check.description}`,
      gap: pass ? undefined : check.description,
      method: 'substring',
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
