import { applyRunEvent, emptyRunsState, seedRun } from '@ethosagent/chat-state';
import { describe, expect, it } from 'vitest';
import { runCardModel } from '../run-card';

const seeded = seedRun(
  emptyRunsState,
  { jobId: 'run_7f3a', runner: 'pi', status: 'running', spendUsd: 0, elapsedMs: 41_000 },
  0,
);

describe('runCardModel', () => {
  it('a seeded run: PI badge in teal, empty now line, Stop available', () => {
    const run = seeded.byId.run_7f3a;
    if (!run) throw new Error('seed');
    const v = runCardModel(run, 'Fix the flaky test');
    expect(v).toMatchObject({
      badge: 'PI',
      header: 'Run · PI · run_7f3a',
      title: 'Fix the flaky test',
      nowLine: '—',
      nowPulsing: true,
      border: 'border',
      canStop: true,
    });
    expect(v.badgeColor).toMatch(/^#/);
    expect(v.statusLine.startsWith('running · ')).toBe(true);
  });

  it('a digest replaces the now line; done is green-bordered and not stoppable', () => {
    const state = applyRunEvent(
      seeded,
      {
        type: 'run.update',
        jobId: 'run_7f3a',
        runner: 'pi',
        status: 'done',
        now: 'wrote 3 files',
        elapsedMs: 90_000,
        spendUsd: 0.1,
        toolCount: 4,
      } as never,
      1,
    );
    const run = state.byId.run_7f3a;
    if (!run) throw new Error('run');
    expect(runCardModel(run, null)).toMatchObject({
      nowLine: 'wrote 3 files',
      nowPulsing: false,
      border: 'success',
      canStop: false,
    });
  });

  it('a parked run is warning-bordered; an unknown runner has no accent', () => {
    const run = seedRun(
      emptyRunsState,
      { jobId: 'j', runner: 'codex', status: 'blocked', spendUsd: 0, elapsedMs: 0 },
      0,
    ).byId.j;
    if (!run) throw new Error('run');
    expect(runCardModel(run, null)).toMatchObject({
      badge: 'CODEX',
      badgeColor: null,
      border: 'warning',
      nowLine: 'paused · waiting for you',
      canStop: true,
    });
  });
});
