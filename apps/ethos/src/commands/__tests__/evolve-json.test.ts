import type { EthosConfig } from '@ethosagent/config';
import type { EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEvolve } from '../evolve';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 16 (context-budget-2): `ethos evolve <verb> --json` prints exactly one JSON document.
// `evolve run` / `--eval-output` need a live LLM; their success shape is covered only up to the
// "no sessions" document (see the eval/nightly notes in the task report).

const config: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'sk-test',
  personality: 'muse',
};

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-evolve-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('evolve --json', () => {
  it('--json success is one JSON doc', async () => {
    await runEvolve(['status', '--json'], config);
    expect(parseOneDoc(h)).toEqual({ ok: true, lastRun: null, pending: [] });
  });

  it('--json archive with no skills is one JSON doc', async () => {
    await runEvolve(['archive', '--json'], config);
    expect(parseOneDoc(h)).toEqual({ ok: true, days: 30, archived: [], dir: null });
  });

  it('--json list-pending is one JSON doc', async () => {
    await runEvolve(['--list-pending', '--json'], config);
    expect(parseOneDoc(h)).toEqual({ ok: true, count: 0, candidates: [] });
  });

  it('--json run with no sessions is one JSON doc', async () => {
    await runEvolve(['run', '--json'], config);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, analyzed: false });
  });

  it('--json prune --yes is one JSON doc', async () => {
    await runEvolve(['prune', '--yes', '--json'], config);
    expect(parseOneDoc(h)).toEqual({
      ok: true,
      days: 7,
      stale: 0,
      rejected: 0,
      failed: [],
      aborted: false,
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runEvolve(['--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });

  it('--json apply without a ref is one INVALID_INPUT doc', async () => {
    await expect(runEvolve(['apply', '--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('--json apply of an unknown candidate is one NOT_FOUND doc', async () => {
    await expect(runEvolve(['apply', 'ghost', '--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    const code: EthosErrorCode = 'NOT_FOUND';
    expect(parseOneDoc(h).error?.code).toBe(code);
  });

  it('--json prune without --yes refuses instead of prompting', async () => {
    await expect(runEvolve(['prune', '--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});
