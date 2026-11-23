import type { AgentLoop } from '@ethosagent/core';
import { DefaultJobRunnerRegistry } from '@ethosagent/core';
import type { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  AgentEvent,
  BackgroundJob,
  DetailRow,
  JobRunner,
  JobRunnerContext,
  Logger,
  RunnerCapabilities,
} from '@ethosagent/types';
import { expect, vi } from 'vitest';
import {
  BackgroundExecutor,
  type BackgroundExecutorConfig,
  type BackgroundExecutorDeps,
} from '../index';

// Fixtures shared by durable-resume.test.ts and durable-resume-review.test.ts.

export const AFFINITY = 'web:host:serve';
export const RELEASED = `released:${AFFINITY}`;
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

export const CAPS: RunnerCapabilities = {
  interactionKinds: ['input'],
  answerScopes: ['once'],
  takeover: 'none',
  resume: 'session',
  autoResume: true,
  steer: true,
  sandbox: 'process',
  transport: 'fake · in-test',
};

export type Script = (ctx: JobRunnerContext, n: number) => AsyncGenerator<AgentEvent>;

export class FakeRunner implements JobRunner {
  readonly name = 'fake-auto';
  readonly ctxs: JobRunnerContext[] = [];
  constructor(
    private readonly script: Script,
    readonly capabilities: RunnerCapabilities = CAPS,
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  describe(_job: BackgroundJob): DetailRow[] {
    return [];
  }
  run(_job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    this.ctxs.push(ctx);
    return this.script(ctx, this.ctxs.length);
  }
}

export const untilAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

export function cfg(over: Partial<BackgroundExecutorConfig> = {}): BackgroundExecutorConfig {
  return {
    maxConcurrentJobs: 2,
    staleMs: 90_000,
    heartbeatMs: 15,
    queuedTtlMs: 900_000,
    maxRootBackgroundUsd: 5.0,
    pollMs: 20,
    resumeOnRestart: true,
    maxResumes: 3,
    resumeTtlMs: 86_400_000,
    ...over,
  };
}

export async function exec(
  store: SQLiteJobStore,
  runner: FakeRunner,
  owner: string,
  over: Partial<BackgroundExecutorDeps> = {},
  config: Partial<BackgroundExecutorConfig> = {},
): Promise<BackgroundExecutor> {
  const runners = new DefaultJobRunnerRegistry();
  runners.register(runner.name, () => runner);
  await runners.resolve(runner.name, { logger: noopLogger });
  return new BackgroundExecutor({
    store,
    loop: {} as AgentLoop,
    runners,
    owner,
    affinity: AFFINITY,
    resumeAffinity: AFFINITY,
    config: cfg(config),
    ...over,
  });
}

export async function started(runner: FakeRunner, n = 1): Promise<void> {
  await vi.waitFor(() => expect(runner.ctxs.length).toBeGreaterThanOrEqual(n), { timeout: 3000 });
}
