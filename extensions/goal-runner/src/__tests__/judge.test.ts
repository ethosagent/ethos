import type { AcceptanceSpec } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { isConverged, judge } from '../judge';

function specWith(overrides?: Partial<AcceptanceSpec>): AcceptanceSpec {
  return { checks: [], rubric: [], threshold: 0.8, ...overrides };
}

describe('judge — command-backed checks', () => {
  it('passes when the command exits 0 and includes a stdout snippet in evidence', async () => {
    const execCommand = vi.fn().mockResolvedValue({ code: 0, stdout: 'all good\n', stderr: '' });
    const spec = specWith({
      checks: [{ id: 'c1', description: 'tests pass', command: 'run-tests' }],
    });

    const verdict = await judge({ output: '', spec }, { execCommand });

    expect(execCommand).toHaveBeenCalledWith('run-tests');
    const result = verdict.perCriterion[0];
    expect(result?.pass).toBe(true);
    expect(result?.evidence).toBe('command exited 0: all good');
    expect(result?.gap).toBeUndefined();
    expect(verdict.score).toBe(1);
  });

  it('fails when the command exits non-zero, with gap = description and stderr snippet', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: 'noise', stderr: 'boom: assertion failed\n' });
    const spec = specWith({
      checks: [{ id: 'c1', description: 'tests pass', command: 'run-tests' }],
    });

    const verdict = await judge({ output: '', spec }, { execCommand });

    const result = verdict.perCriterion[0];
    expect(result?.pass).toBe(false);
    expect(result?.evidence).toBe('command exited 1: boom: assertion failed');
    expect(result?.gap).toBe('tests pass');
    expect(verdict.score).toBe(0);
  });

  it('falls back to the stdout snippet when stderr is empty on failure', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ code: 2, stdout: 'only stdout here', stderr: '' });
    const spec = specWith({
      checks: [{ id: 'c1', description: 'lint clean', command: 'run-lint' }],
    });

    const verdict = await judge({ output: '', spec }, { execCommand });

    expect(verdict.perCriterion[0]?.evidence).toBe('command exited 2: only stdout here');
  });

  it('treats a rejecting execCommand (timeout) as a failed check, not an unhandled rejection', async () => {
    const execCommand = vi.fn().mockRejectedValue(new Error('timed out after 30000ms'));
    const spec = specWith({
      checks: [{ id: 'c1', description: 'server responds', command: 'curl localhost' }],
    });

    const verdict = await judge({ output: '', spec }, { execCommand });

    const result = verdict.perCriterion[0];
    expect(result?.pass).toBe(false);
    expect(result?.evidence).toBe('command failed: timed out after 30000ms');
    expect(result?.gap).toBe('server responds');
    expect(verdict.score).toBe(0);
  });

  it('truncates evidence snippets to ~200 chars', async () => {
    const execCommand = vi.fn().mockResolvedValue({ code: 0, stdout: 'x'.repeat(500), stderr: '' });
    const spec = specWith({ checks: [{ id: 'c1', description: 'big output', command: 'noisy' }] });

    const verdict = await judge({ output: '', spec }, { execCommand });

    expect(verdict.perCriterion[0]?.evidence).toBe(`command exited 0: ${'x'.repeat(200)}`);
  });

  it('runs the real default execCommand for trivial commands (smoke)', async () => {
    const spec = specWith({
      checks: [
        { id: 'ok', description: 'true exits 0', command: 'true' },
        { id: 'nope', description: 'exit 1 fails', command: 'exit 1' },
      ],
    });

    const verdict = await judge({ output: '', spec });

    const ok = verdict.perCriterion.find((c) => c.id === 'ok');
    const nope = verdict.perCriterion.find((c) => c.id === 'nope');
    expect(ok?.pass).toBe(true);
    expect(ok?.evidence).toBe('command exited 0');
    expect(nope?.pass).toBe(false);
    expect(nope?.evidence).toBe('command exited 1');
    expect(nope?.gap).toBe('exit 1 fails');
  });
});

describe('judge — substring checks (no command)', () => {
  it('passes when the output contains the description, without invoking execCommand', async () => {
    const execCommand = vi.fn();
    const spec = specWith({ checks: [{ id: 'c1', description: 'Deploy Complete' }] });

    const verdict = await judge(
      { output: 'the deploy complete message appeared', spec },
      { execCommand },
    );

    expect(execCommand).not.toHaveBeenCalled();
    const result = verdict.perCriterion[0];
    expect(result?.pass).toBe(true);
    expect(result?.evidence).toBe('check passed: Deploy Complete');
  });

  it('fails when the output does not contain the description', async () => {
    const spec = specWith({ checks: [{ id: 'c1', description: 'deploy complete' }] });

    const verdict = await judge({ output: 'nothing happened', spec });

    const result = verdict.perCriterion[0];
    expect(result?.pass).toBe(false);
    expect(result?.evidence).toBe('check failed: deploy complete');
    expect(result?.gap).toBe('deploy complete');
    expect(result?.method).toBe('substring');
    expect(verdict.score).toBe(0);
  });
});

describe('judge — injected judgeCheck for command-less checks', () => {
  const csvCheck = { id: 'c1', description: 'All CSV symbols are in the database' };
  const spec = specWith({
    checks: [csvCheck, { id: 'cmd', description: 'tests pass', command: 'run-tests' }],
    threshold: 0,
  });

  it('asks the judge (not a substring match) and records method llm', async () => {
    const judgeCheck = vi.fn().mockResolvedValue({ pass: true, evidence: '3169/3169 rows' });
    const execCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const verdict = await judge(
      { output: 'inserted 3169 symbols', spec, goalText: 'Load the CSV' },
      { judgeCheck, execCommand },
    );

    expect(judgeCheck).toHaveBeenCalledTimes(1);
    expect(judgeCheck).toHaveBeenCalledWith({
      check: { id: 'c1', description: 'All CSV symbols are in the database' },
      goalText: 'Load the CSV',
      output: 'inserted 3169 symbols',
    });
    // Command checks stay commands — the judge never sees them.
    expect(execCommand).toHaveBeenCalledWith('run-tests');
    const c1 = verdict.perCriterion.find((c) => c.id === 'c1');
    expect(c1).toEqual({ id: 'c1', pass: true, evidence: '3169/3169 rows', method: 'llm' });
    expect(verdict.perCriterion.find((c) => c.id === 'cmd')?.method).toBe('command');
    expect(isConverged(verdict, spec.threshold)).toBe(true);
  });

  it('records a not-met verdict with the description as the gap', async () => {
    const judgeCheck = vi.fn().mockResolvedValue({ pass: false, evidence: 'only a plan' });
    const verdict = await judge(
      {
        output: 'I will load them',
        spec: specWith({ checks: [csvCheck] }),
      },
      { judgeCheck },
    );
    expect(verdict.perCriterion[0]).toEqual({
      id: 'c1',
      pass: false,
      evidence: 'only a plan',
      gap: 'All CSV symbols are in the database',
      method: 'llm',
    });
    expect(verdict.score).toBe(0);
  });

  it('fails closed when the judge throws', async () => {
    const judgeCheck = vi.fn().mockRejectedValue(new Error('provider down'));
    const verdict = await judge(
      {
        output: 'All CSV symbols are in the database',
        spec: specWith({ checks: [csvCheck] }),
      },
      { judgeCheck },
    );
    const result = verdict.perCriterion[0];
    expect(result?.pass).toBe(false);
    expect(result?.evidence).toBe('judge unavailable: provider down');
    expect(result?.gap).toBe('All CSV symbols are in the database');
    expect(result?.method).toBe('llm');
  });
});

describe('judge — mixed spec scoring and convergence', () => {
  const mixedSpec = specWith({
    checks: [
      { id: 'cmd', description: 'tests pass', command: 'run-tests' },
      { id: 'sub', description: 'done' },
    ],
    rubric: [{ id: 'r1', description: 'quality', weight: 2 }],
    threshold: 0.4,
  });

  it('keeps rubric score math unchanged when all checks pass', async () => {
    const execCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const verdict = await judge({ output: 'work is done', spec: mixedSpec }, { execCommand });

    // Rubric placeholder: 0.5 * weight 2 / total weight 2 = 0.5.
    expect(verdict.score).toBe(0.5);
    expect(verdict.perCriterion).toHaveLength(3);
    expect(isConverged(verdict, mixedSpec.threshold)).toBe(true);
  });

  it('zeroes the score and blocks convergence when the command check fails', async () => {
    const execCommand = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'fail' });

    const verdict = await judge({ output: 'work is done', spec: mixedSpec }, { execCommand });

    expect(verdict.score).toBe(0);
    expect(isConverged(verdict, mixedSpec.threshold)).toBe(false);
  });
});
