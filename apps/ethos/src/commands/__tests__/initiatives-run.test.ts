import { EventEmitter } from 'node:events';
import { createInitiativeRunner, type InitiativeRunner } from '@ethosagent/initiative-runner';
import { EthosError } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { abortOnSignals, parseRunArgs, runInitiativesCommand } from '../initiatives';

// A real runner whose `load` finds nothing: the unknown-id error comes from the runner, not a double.
function runnerWithNoInitiatives(): InitiativeRunner {
  const refuse = () => {
    throw new Error('the store must not be touched for an unknown initiative');
  };
  return createInitiativeRunner({
    store: {
      reserveAndOpenWindow: refuse,
      touchReservation: refuse,
      closeWindow: refuse,
      getInitiative: refuse,
      getExploration: () => null,
      transitionExploration: refuse,
      submitBrief: refuse,
      list: refuse,
      explorations: refuse,
      ideas: refuse,
      budget: refuse,
      get: refuse,
    },
    load: async () => null,
    buildRegistry: refuse,
    llm: {} as never,
    safety: {} as never,
    personalities: {} as never,
  });
}

describe('ethos initiatives run', () => {
  it('CLI raises EthosError on unknown id', async () => {
    const runner = runnerWithNoInitiatives();
    for (const args of [
      ['run', 'nope', '--survey'],
      ['run', 'nope', '--explore', 'EXP-1'],
    ]) {
      const err = await runInitiativesCommand(args, runner).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EthosError);
      expect(err).toMatchObject({ code: 'INVALID_INPUT' });
      expect((err as EthosError).cause).toContain('nope');
    }
  });

  it('parses the two forms and refuses everything else with an EthosError', () => {
    expect(parseRunArgs(['run', 'a', '--survey'])).toEqual({ kind: 'survey', initiativeId: 'a' });
    expect(parseRunArgs(['run', 'a', '--explore', 'EXP-2'])).toEqual({
      kind: 'window',
      initiativeId: 'a',
      explorationId: 'EXP-2',
    });
    for (const bad of [
      [],
      ['list'],
      ['run'],
      ['run', 'a'],
      ['run', 'a', '--survey', '--explore', 'EXP-1'],
      ['run', 'a', '--explore'],
    ]) {
      expect(() => parseRunArgs(bad)).toThrow(EthosError);
    }
  });

  it('prints tools, reads, findings and cost', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    const runner: InitiativeRunner = {
      runSurvey: async () => ({
        windowId: 'W-1',
        kind: 'survey',
        initiativeId: 'a',
        explorationId: null,
        spentUsd: 0.1234,
        endReason: 'done',
        toolsUsed: ['initiative_propose', 'read_file'],
        reads: ['read_file: /repo/README.md'],
        proposals: [],
        ideas: [],
        findings: [],
        text: '',
        started: [],
        waiting: [],
        outcome: null,
        drafts: [],
      }),
      runWindow: async () => {
        throw new Error('unused');
      },
      runScan: async () => {
        throw new Error('unused');
      },
      materialiseDrafts: async () => [],
      pauseIdle: () => [],
    };
    await runInitiativesCommand(['run', 'a', '--survey'], runner);
    spy.mockRestore();
    const out = lines.join('\n');
    expect(out).toContain('tools:  initiative_propose, read_file');
    expect(out).toContain('read_file: /repo/README.md');
    expect(out).toContain('cost: $0.1234');
  });
});

describe('stopping a manual run', () => {
  const report = {
    windowId: 'W-1',
    kind: 'survey' as const,
    initiativeId: 'a',
    explorationId: null,
    spentUsd: 0,
    endReason: 'aborted',
    toolsUsed: [],
    reads: [],
    proposals: [],
    ideas: [],
    findings: [],
    text: '',
    started: [],
    waiting: [],
    outcome: null,
    drafts: [],
  };

  it('SIGINT and SIGTERM abort the run signal once, and the listeners are removable', () => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const proc = new EventEmitter();
      const ctl = new AbortController();
      const detach = abortOnSignals(ctl, proc as unknown as NodeJS.Process);
      expect(ctl.signal.aborted).toBe(false);
      proc.emit(sig);
      expect(ctl.signal.aborted).toBe(true);
      detach();
      expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
    }
  });

  it('the run is handed the signal, so a signal during the run reaches the runner', async () => {
    const proc = new EventEmitter();
    const ctl = new AbortController();
    abortOnSignals(ctl, proc as unknown as NodeJS.Process);
    let seen: AbortSignal | undefined;
    const runner: InitiativeRunner = {
      runSurvey: async (_id, opts) => {
        seen = opts?.signal;
        proc.emit('SIGINT'); // Ctrl-C while the window is open
        return report;
      },
      runWindow: async () => report,
      runScan: async () => report,
      materialiseDrafts: async () => [],
      pauseIdle: () => [],
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInitiativesCommand(['run', 'a', '--survey'], runner, { signal: ctl.signal });
    vi.restoreAllMocks();
    expect(seen).toBe(ctl.signal);
    expect(seen?.aborted).toBe(true);
  });
});
