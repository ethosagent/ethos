import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { EthosError, type EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEval } from '../eval';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 16 (context-budget-2): `ethos eval run|local --json` prints exactly one JSON document.
// The agent loop and the EvalRunner are mocked at their seams (`createAgentLoop` in wiring,
// `EvalRunner` in eval-harness): a real scored run needs a live LLM. The runner calls the
// progress callback it is given, so a progress bar leaking into stdout fails the one-doc check.

vi.mock('../../wiring', async (orig) => ({
  ...(await orig<typeof import('../../wiring')>()),
  createAgentLoop: vi.fn(async () => ({ loop: {}, dispose: async () => {} })),
}));
vi.mock('../../lib/non-interactive-approval', () => ({ gateNonInteractiveLoop: () => () => {} }));
vi.mock('../../lib/release-command-runtime', () => ({ releaseCommandRuntime: async () => {} }));
vi.mock('@ethosagent/eval-harness', async (orig) => ({
  ...(await orig<typeof import('@ethosagent/eval-harness')>()),
  EvalRunner: class {
    async run(_t: unknown, _e: unknown, onProgress?: (done: number, total: number) => void) {
      onProgress?.(1, 1);
      return { passed: 1, failed: 1, avgScore: 0.5 };
    }
  },
}));

const config: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'sk-test',
  personality: 'muse',
};

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-eval-json-');
});

afterEach(async () => {
  await h.teardown();
});

function stateFile(name: string): string {
  return join(h.scopeDir, '..', '..', name);
}

describe('eval --json', () => {
  it('--json success is one JSON doc', async () => {
    const tasks = stateFile('tasks.jsonl');
    const expected = stateFile('expected.jsonl');
    await writeFile(tasks, '');
    await writeFile(expected, '');
    await runEval(['run', tasks, '--expected', expected, '--json'], config);
    expect(parseOneDoc(h)).toEqual({
      ok: true,
      tasks: 0,
      passed: 0,
      failed: 0,
      avgScore: 0,
      output: null,
    });
  });

  it('--json local with an empty dataset is one JSON doc', async () => {
    const dataset = stateFile('dataset');
    await mkdir(dataset, { recursive: true });
    await writeFile(join(dataset, 'tasks.jsonl'), '');
    await writeFile(join(dataset, 'expected.jsonl'), '');
    await runEval(['local', '--dataset', dataset, '--json'], config);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, mode: 'local', tasks: 0, output: null });
  });

  it('--json scored run is one JSON doc', async () => {
    const tasks = stateFile('tasks.jsonl');
    const expected = stateFile('expected.jsonl');
    await writeFile(tasks, `${JSON.stringify({ id: 't1', prompt: 'hi' })}\n`);
    await writeFile(expected, `${JSON.stringify({ id: 't1', expected: 'hi' })}\n`);
    await expect(runEval(['run', tasks, '--expected', expected, '--json'], config)).rejects.toThrow(
      `${EXIT}(1)`,
    );
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, tasks: 1, passed: 1, failed: 1, avgScore: 0.5 });
    expect(doc.output).toEqual(expect.stringContaining('tasks.eval.jsonl'));
    expect(doc.evolve).toBeNull();
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runEval(['--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });

  it('--json missing --expected throws INVALID_INPUT for index.ts to emit', async () => {
    const err = await runEval(['run', 'tasks.jsonl', '--json'], config).catch((e: unknown) => e);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe(code);
    expect(h.stdout()).toBe('');
  });

  it('--json unreadable tasks file is one FILE_NOT_FOUND doc', async () => {
    await expect(
      runEval(
        ['run', stateFile('nope.jsonl'), '--expected', stateFile('x.jsonl'), '--json'],
        config,
      ),
    ).rejects.toThrow(`${EXIT}(1)`);
    const code: EthosErrorCode = 'FILE_NOT_FOUND';
    expect(parseOneDoc(h).error?.code).toBe(code);
  });
});
