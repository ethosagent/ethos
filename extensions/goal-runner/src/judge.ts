import { execFile } from 'node:child_process';
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
  /** Override command execution (tests). Defaults to running via `sh -c`. */
  execCommand?: (command: string) => Promise<CommandResult>;
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
 * Checks with a `command` execute it via `sh -c` (30s timeout) and pass iff it
 * exits 0; commands run sequentially since they may touch shared state. Checks
 * without a command fall back to a substring match against the attempt output.
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
