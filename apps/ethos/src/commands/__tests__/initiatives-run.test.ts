import { createInitiativeRunner, type InitiativeRunner } from '@ethosagent/initiative-runner';
import { EthosError } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { parseRunArgs, runInitiativesCommand } from '../initiatives';

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
