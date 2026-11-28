// plan world-model 6.2: `world.extraction: 'propose'` threads the world capture router into the
// ONE MemoryCaptureRunner `createAgentLoop` builds (build-agent-loop.ts), as `routeFact`. Through
// the real composition root: no second LLM call, and the capture call stays metered as
// `memory_capture`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import { MemoryCaptureRunner, type RouteFactFn } from '@ethosagent/memory-capture';
import Database from '@ethosagent/sqlite';
import type { CompletionChunk, CompletionOptions } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';
import { usageChunk } from './helpers/usage-test-kit';

const PROMPT =
  'Ravi now owns billing-svc and I need you to remember that for the on-call rota, please.';
const GRAPH_LINE =
  'MEMORY|0.8|Ravi owns billing-svc.|{"subject":"Ravi","relation":"owns","object":"billing-svc"}';

// The private world has no schema until a build or a schema change writes one; the extraction
// router only proposes what an existing schema can hold, so the test seeds one (schema.yaml of
// `personality:engineer`, extensions/world-service/src/schema-service.ts `worldSchemaPath`).
const SCHEMA = `version: 1
entities:
  Person: { attrs: {} }
  Service: { attrs: {} }
edges:
  owns: { from: [Person], to: [Service], attrs: {}, unique: to }
`;

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-world-extraction-wiring-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
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

/** Records every model call; a capture call answers with one triple-bearing fact. */
function stubProvider(): { systems: Array<string | undefined> } {
  const systems: Array<string | undefined> = [];
  vi.spyOn(AnthropicProvider.prototype, 'complete').mockImplementation(async function* (
    _messages,
    _tools,
    options: CompletionOptions,
  ): AsyncGenerator<CompletionChunk> {
    systems.push(options.system);
    if (options.system?.includes('extract durable facts')) {
      yield { type: 'text_delta', text: GRAPH_LINE };
      yield usageChunk(10, 5, 0.01);
      yield { type: 'done', finishReason: 'end_turn' };
      return;
    }
    yield { type: 'text_delta', text: 'Noted.' };
    yield usageChunk(100, 10, 1);
    yield { type: 'done', finishReason: 'end_turn' };
  });
  return { systems };
}

function config(world: WiringConfig['world']): WiringConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: 'sk-test',
    compaction: { autoCompact: false },
    memory: 'markdown',
    personality: 'engineer',
    memoryCapture: { enabled: true },
    ...(world ? { world } : {}),
  };
}

async function assemble(world: WiringConfig['world']) {
  const dataDir = mkdtempSync(join(home, 'data-'));
  mkdirSync(dataDir, { recursive: true });
  process.env.ETHOS_STATE_DIR = dataDir;
  const personaDir = join(dataDir, 'personalities', 'engineer');
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(join(personaDir, 'config.yaml'), 'name: engineer\n');
  writeFileSync(join(personaDir, 'SOUL.md'), '# Core\nI am engineer.\n');
  writeFileSync(join(personaDir, 'toolset.yaml'), '- read_file\n');
  const schemaDir = join(dataDir, 'worlds', '.private', 'engineer');
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(join(schemaDir, 'schema.yaml'), SCHEMA);
  const runners: MemoryCaptureRunner[] = [];
  const original = MemoryCaptureRunner.prototype.registerHook;
  vi.spyOn(MemoryCaptureRunner.prototype, 'registerHook').mockImplementation(function (
    this: MemoryCaptureRunner,
    hooks,
  ) {
    runners.push(this);
    return original.call(this, hooks);
  });
  const runtime = await createAgentLoop(config(world), {
    dataDir,
    workingDir: home,
    disableDocker: true,
    profile: 'cli',
  });
  expect(runners).toHaveLength(1);
  const runner = runners[0];
  if (!runner) throw new Error('capture runner was not built');
  // The runner's options are private; the port is what wiring chose to hand it.
  const routeFact = (runner as unknown as { opts: { routeFact?: RouteFactFn } }).opts.routeFact;
  return { runtime, runner, routeFact, dataDir };
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) {
    // drain to exhaustion: capture runs after `done`
  }
}

function count(dataDir: string, sql: string): number {
  const db = new Database(join(dataDir, 'worlds', 'service.db'));
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('world extraction wiring (6.2)', () => {
  it('extraction off → routeFact absent', async () => {
    for (const world of [
      undefined,
      { enabled: true },
      { enabled: true, extraction: 'off' },
    ] as const) {
      const { runtime, routeFact } = await assemble(world);
      try {
        expect(routeFact).toBeUndefined();
      } finally {
        await runtime.dispose();
        vi.restoreAllMocks();
      }
    }
    // extraction 'propose' without `enabled` composes no runtime, so there is nothing to route to.
    const { runtime, routeFact } = await assemble({ extraction: 'propose' });
    try {
      expect(routeFact).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  }, 180_000);

  it('extraction on → a private turn naming a handover yields one pending proposal', async () => {
    stubProvider();
    const { runtime, runner, routeFact, dataDir } = await assemble({
      enabled: true,
      extraction: 'propose',
    });
    try {
      expect(routeFact).toBeTypeOf('function');
      await drain(runtime.loop.run(PROMPT, { sessionKey: 'cli:world-extract' }));
      await runner.whenIdle();
      // One batch: two entities and the edge, proposed (never applied) in the private world.
      expect(count(dataDir, 'SELECT COUNT(DISTINCT batch_id) AS n FROM proposals')).toBe(1);
      expect(
        count(dataDir, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'"),
      ).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  }, 180_000);

  it('no second LLM call per turn', async () => {
    const { systems } = stubProvider();
    const { runtime, runner } = await assemble({ enabled: true, extraction: 'propose' });
    try {
      await drain(runtime.loop.run(PROMPT, { sessionKey: 'cli:world-extract-calls' }));
      await runner.whenIdle();
      const capture = systems.filter((s) => s?.includes('extract durable facts'));
      expect(capture).toHaveLength(1);
      // The turn's own call plus the one capture call: routing added nothing.
      expect(systems).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
});
