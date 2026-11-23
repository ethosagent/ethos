import type { AgentLoop } from '@ethosagent/core';
import type { BackgroundJob, JobRunnerContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { EthosJobRunner } from '../ethos-job-runner';
import { createJobSteerSink } from '../job-steer-sink';
import { resumePrompt } from '../resume';
import { SUMMARY_INSTRUCTION } from '../summary';

// L5 — the resumed run is the SAME `loop.run` call as a first run: same session,
// audience, narrowing and steer sink; only the prompt and the taint flag differ.

interface Call {
  prompt: string;
  opts: Record<string, unknown>;
}

function setup() {
  const calls: Call[] = [];
  const loop = {
    run: (prompt: string, opts: Record<string, unknown>) => {
      calls.push({ prompt, opts });
      return (async function* () {})();
    },
  } as unknown as AgentLoop;
  return { calls, runner: new EthosJobRunner(loop) };
}

function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'j1',
    prompt: 'build the thing',
    childSessionKey: 'child-1',
    rootSessionKey: 'root-1',
    depth: 1,
    roomAudience: 'shared',
    toolsetNarrowing: { narrow: ['read_file'], exclude: ['terminal'] },
    ...over,
  } as BackgroundJob;
}

function ctx(over: Partial<JobRunnerContext> = {}): JobRunnerContext {
  return {
    signal: new AbortController().signal,
    steerSink: createJobSteerSink(),
    emitArtifact: () => {},
    appendLog: () => {},
    ...over,
  } as unknown as JobRunnerContext;
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) void _;
}

describe('EthosJobRunner resume', () => {
  it('a resumed run re-enters the same session with the same options and the resume prompt', async () => {
    const { calls, runner } = setup();
    const j = job({ tainted: true });
    const c = ctx();
    await drain(runner.run(j, c));
    const resume = { attempt: 1, reason: 'restart' as const, interruptedTools: ['terminal'] };
    await drain(runner.run(j, { ...c, resume }));

    const [first, second] = calls;
    expect(first?.prompt).toBe(j.prompt + SUMMARY_INSTRUCTION);
    expect(second?.prompt).toBe(resumePrompt(resume) + SUMMARY_INSTRUCTION);
    expect(second?.prompt).toContain('terminal');
    for (const key of [
      'sessionKey',
      'roomAudience',
      'toolsetNarrow',
      'toolsetExclude',
      'steerSink',
    ]) {
      expect(second?.opts[key]).toEqual(first?.opts[key]);
    }
    expect(second?.opts.sessionKey).toBe('child-1');
    expect(second?.opts.roomAudience).toBe('shared');
  });

  it('passes untrustedOrigin only because the job is tainted', async () => {
    const { calls, runner } = setup();
    await drain(runner.run(job({ tainted: true }), ctx()));
    await drain(runner.run(job(), ctx()));
    expect(calls[0]?.opts.untrustedOrigin).toBe(true);
    expect('untrustedOrigin' in (calls[1]?.opts ?? {})).toBe(false);
  });
});
