// S12 follow-up (plan openclaw-2026.9.6-gaps) — a background child keeps the
// parent turn's tool narrowing. `delegate_task(background: true)` persists
// `ToolContext.toolsetNarrowing` on the job row (`BackgroundJob.toolsetNarrowing`,
// job-store v9) and `EthosJobRunner.run` hands it back to the child turn as
// `toolsetNarrow`/`toolsetExclude`. Driven through a REAL AgentLoop and a real
// SQLiteJobStore so what is asserted is the tool list the child's model sees.

import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  CompletionChunk,
  JobRunnerContext,
  LLMProvider,
  ToolContext,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { EthosJobRunner, narrowedToolset } from '../index';

function recordingLLM(seen: string[][]): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages, tools: ToolDefinitionLite[]): AsyncIterable<CompletionChunk> {
      seen.push(tools.map((t) => t.name).sort());
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function loopWith(seen: string[][]): AgentLoop {
  const tools = new DefaultToolRegistry();
  for (const name of ['read_file', 'terminal', 'web_search']) {
    tools.register({
      name,
      description: name,
      schema: { type: 'object' },
      capabilities: {},
      toolset: 'probe',
      async execute() {
        return { ok: true, value: 'ok' };
      },
    });
  }
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'p', name: 'P', toolset: ['read_file', 'terminal', 'web_search'] });
  return new AgentLoop({
    llm: recordingLLM(seen),
    tools,
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
}

async function drainChild(
  narrowing: ToolContext['toolsetNarrowing'],
): Promise<{ seen: string[][]; stored: unknown }> {
  const seen: string[][] = [];
  const store = new SQLiteJobStore(':memory:');
  const job = await store.create({
    owner: 'o',
    parentSessionKey: 'parent',
    rootSessionKey: 'parent',
    childSessionKey: 'parent:job:task:abcd',
    personalityId: 'p',
    depth: 1,
    prompt: 'do it',
    ...(narrowing ? { toolsetNarrowing: narrowing } : {}),
  });
  const row = await store.get(job.id);
  if (!row) throw new Error('job row missing');
  const runner = new EthosJobRunner(loopWith(seen));
  const ctx: JobRunnerContext = {
    signal: new AbortController().signal,
    steerSink: { push: () => false, drain: () => [], depth: () => 0 },
    emitArtifact: () => {},
    appendLog: () => {},
  };
  for await (const _ of runner.run(row, ctx)) {
    // drain
  }
  store.close();
  return { seen, stored: row.toolsetNarrowing };
}

describe('background child keeps the parent turn’s tool narrowing', () => {
  it("the child's toolset equals the narrowed set, not the personality's", async () => {
    const { seen, stored } = await drainChild({
      narrow: ['read_file', 'terminal'],
      exclude: ['terminal'],
    });
    expect(stored).toEqual({ narrow: ['read_file', 'terminal'], exclude: ['terminal'] });
    expect(seen[0]).toEqual(['read_file']);
  });

  it('a job with no narrowing runs with the full personality toolset', async () => {
    const { seen, stored } = await drainChild(undefined);
    expect(stored).toBeUndefined();
    expect(seen[0]).toEqual(['read_file', 'terminal', 'web_search']);
  });
});

// The ACP and Pi runners cannot take `toolsetNarrow`; they narrow the toolset
// their personality gate (`createPersonalityGate`) checks instead.
describe('narrowedToolset', () => {
  it('intersects with narrow, then subtracts exclude', () => {
    expect(
      narrowedToolset(['read_file', 'terminal', 'web_search'], {
        narrow: ['read_file', 'terminal', 'delegate_task'],
        exclude: ['terminal'],
      }),
    ).toEqual(['read_file']);
  });

  it('uses narrow as the list when the personality has no toolset', () => {
    expect(narrowedToolset(undefined, { narrow: ['read_file'] })).toEqual(['read_file']);
  });

  it('leaves the toolset alone when there is no narrowing', () => {
    expect(narrowedToolset(['read_file'], undefined)).toEqual(['read_file']);
    expect(narrowedToolset(undefined, undefined)).toBeUndefined();
  });

  it('cannot subtract an exclusion from an unrestricted toolset (documented limitation)', () => {
    expect(narrowedToolset(undefined, { exclude: ['terminal'] })).toBeUndefined();
  });
});
