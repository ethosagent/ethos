// T1.8 — a live turn resolves through the `modelRegistry.*` read from
// config.yaml, through the REAL composition root. Before this,
// `build-agent-loop.ts` handed every loop an empty registry, so every turn took
// the D11b legacy path and `modelRegistry.*` was inert.
//
// HOME and ETHOS_STATE_DIR point at a temp dir; completions are stubbed on the
// OpenAI-compat provider prototype, so nothing leaves the process.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type { AgentEvent, CompletionChunk, CompletionOptions } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../index';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-registry-turn-'));
  dataDir = join(home, '.ethos');
  for (const [id, model] of [
    ['plain', undefined],
    ['pinned-b', 'fast-b'],
  ] as const) {
    const dir = join(dataDir, 'personalities', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      `name: ${id}\ndescription: test\n${model ? `model: ${model}\n` : ''}`,
    );
    writeFileSync(join(dir, 'SOUL.md'), `I am ${id}.\n`);
    writeFileSync(join(dir, 'toolset.yaml'), '[]\n');
  }
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CHAIN = [
  'provider: ollama',
  'model: model-a',
  'apiKey: sk-dummy',
  'providers.0.provider: ollama',
  'providers.0.id: local-a',
  'providers.0.model: model-a',
  'providers.0.baseUrl: http://127.0.0.1:9/v1',
  'providers.0.apiKey: sk-dummy',
  'providers.1.provider: ollama',
  'providers.1.id: local-b',
  'providers.1.model: model-b',
  'providers.1.baseUrl: http://127.0.0.1:9/v1',
  'providers.1.apiKey: sk-dummy',
];

const REGISTRY = [
  'modelRegistry.fast-a.provider: local-a',
  'modelRegistry.fast-a.modelId: model-a',
  'modelRegistry.fast-b.provider: local-b',
  'modelRegistry.fast-b.modelId: model-b',
  'modelRegistry.default: fast-a',
];

/** Every completion the stub served: which instance, and the options it got. */
function stubCompletions(): Array<{ model: string; options: CompletionOptions }> {
  const calls: Array<{ model: string; options: CompletionOptions }> = [];
  vi.spyOn(OpenAICompatProvider.prototype, 'complete').mockImplementation(function (
    this: OpenAICompatProvider,
    _messages,
    _tools,
    options,
  ) {
    calls.push({ model: this.model, options });
    return (async function* (): AsyncGenerator<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    })();
  });
  return calls;
}

async function runStartFor(lines: string[], personalityId: string) {
  const runtime = await createAgentLoop(parseConfigYaml(`${lines.join('\n')}\n`), {
    dataDir,
    workingDir: home,
    profile: 'web',
    disableDocker: true,
  });
  try {
    await runtime.refreshPersonalities();
    const events: AgentEvent[] = [];
    for await (const e of runtime.loop.run('hi', {
      personalityId,
      sessionKey: `cli:${personalityId}-${Math.random()}`,
    })) {
      events.push(e);
    }
    const error = events.find((e) => e.type === 'error');
    if (error) throw new Error(`turn errored: ${JSON.stringify(error)}`);
    return events.find((e) => e.type === 'run_start');
  } finally {
    await runtime.dispose();
  }
}

describe('createAgentLoop — the turn resolves through modelRegistry from config (T1.8)', () => {
  it('an alias on provider entry B runs B’s modelId on B, and run_start says so', async () => {
    const calls = stubCompletions();

    const runStart = await runStartFor([...CHAIN, ...REGISTRY], 'pinned-b');

    expect(runStart).toMatchObject({
      type: 'run_start',
      provider: 'local-b',
      model: 'model-b',
      source: 'personality',
    });
    expect(calls.map((c) => c.model)).toEqual(['model-b']);
    expect(calls[0]?.options.modelOverride).toBeUndefined();
  });

  it('an undeclared personality takes the registry default', async () => {
    stubCompletions();

    const runStart = await runStartFor([...CHAIN, ...REGISTRY], 'plain');

    expect(runStart).toMatchObject({ provider: 'local-a', model: 'model-a', source: 'default' });
  });

  it('with no registry the D11b legacy path is unchanged: the declaration is inert', async () => {
    const calls = stubCompletions();

    const runStart = await runStartFor(CHAIN, 'pinned-b');

    expect(runStart).toMatchObject({
      provider: 'chain(ollama,ollama)',
      model: 'model-a',
      source: 'default',
    });
    expect(calls.map((c) => c.model)).toEqual(['model-a']);
  });
});
