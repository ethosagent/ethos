// plan personality-memory-boundary G1-6 — a background child runs no less
// shared than the turn that spawned it. The job row carries the audience
// (`BackgroundJob.roomAudience`, stamped by `delegate_task` / gateway
// `/background` / CLI / ACP) and `EthosJobRunner.run` applies it through
// `jobRoomAudience`; an unstamped legacy row resolves from its origin chat
// (D11). Driven through a REAL AgentLoop and a real SQLiteJobStore so what is
// asserted is the tool list the child's model sees and the session stamp.

import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  CompletionChunk,
  CreateBackgroundJobInput,
  JobRunnerContext,
  LLMProvider,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { EthosJobRunner, jobRoomAudience } from '../index';

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

async function drainChild(
  fields: Partial<CreateBackgroundJobInput>,
): Promise<{ tools: string[] | undefined; stamp: unknown }> {
  const seen: string[][] = [];
  const tools = new DefaultToolRegistry();
  for (const name of ['read_file', 'memory_read']) {
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
  personalities.define({ id: 'p', name: 'P', toolset: ['read_file', 'memory_read'] });
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm: recordingLLM(seen),
    tools,
    personalities,
    session,
    safety: createTestSafety(),
  });

  const store = new SQLiteJobStore(':memory:');
  const job = await store.create({
    owner: 'o',
    parentSessionKey: 'parent',
    rootSessionKey: 'parent',
    childSessionKey: 'parent:job:task:abcd',
    personalityId: 'p',
    depth: 1,
    prompt: 'do it',
    ...fields,
  });
  const row = await store.get(job.id);
  if (!row) throw new Error('job row missing');
  const ctx: JobRunnerContext = {
    signal: new AbortController().signal,
    steerSink: { push: () => false, drain: () => [], depth: () => 0 },
    emitArtifact: () => {},
    appendLog: () => {},
  };
  for await (const _ of new EthosJobRunner(loop).run(row, ctx)) {
    // drain
  }
  store.close();
  const child = await session.getSessionByKey('parent:job:task:abcd');
  return { tools: seen[0], stamp: child?.metadata?.roomAudience };
}

describe('EthosJobRunner applies the job’s room audience', () => {
  it('a job stamped shared runs shared: memory tools gone, session stamped', async () => {
    const { tools, stamp } = await drainChild({ roomAudience: 'shared' });
    expect(tools).toEqual(['read_file']);
    expect(stamp).toBe('shared');
  });

  it('a job stamped private runs private, even from a group origin', async () => {
    const { tools, stamp } = await drainChild({
      roomAudience: 'private',
      originPlatform: 'telegram',
      originChatId: '-100123',
    });
    expect(tools).toEqual(['memory_read', 'read_file']);
    expect(stamp).toBeUndefined();
  });

  it('a legacy (unstamped) job from a group origin runs shared (D11)', async () => {
    const { tools, stamp } = await drainChild({
      originPlatform: 'telegram',
      originChatId: '-100123',
    });
    expect(tools).toEqual(['read_file']);
    expect(stamp).toBe('shared');
  });

  it('a legacy job with no origin (CLI, web, ACP) runs private', async () => {
    const { tools, stamp } = await drainChild({});
    expect(tools).toEqual(['memory_read', 'read_file']);
    expect(stamp).toBeUndefined();
  });
});

describe('jobRoomAudience', () => {
  it('a stamp wins over the origin', () => {
    expect(
      jobRoomAudience({ roomAudience: 'shared', originPlatform: 'telegram', originChatId: '42' }),
    ).toBe('shared');
    expect(
      jobRoomAudience({ roomAudience: 'private', originPlatform: 'discord', originChatId: '1' }),
    ).toBe('private');
  });

  it('an unstamped row with a provably one-to-one origin is private', () => {
    expect(jobRoomAudience({ originPlatform: 'telegram', originChatId: '42' })).toBe('private');
    expect(jobRoomAudience({ originPlatform: 'slack', originChatId: 'D123' })).toBe('private');
    expect(jobRoomAudience({ originPlatform: 'whatsapp', originChatId: '1@s.whatsapp.net' })).toBe(
      'private',
    );
  });

  it('an unstamped row with an unclassifiable or group origin is shared (fail closed)', () => {
    expect(jobRoomAudience({ originPlatform: 'discord', originChatId: '123' })).toBe('shared');
    expect(jobRoomAudience({ originPlatform: 'email', originChatId: 'a@b.c' })).toBe('shared');
    expect(jobRoomAudience({ originPlatform: 'slack', originChatId: 'C123' })).toBe('shared');
    expect(jobRoomAudience({ originPlatform: 'telegram' })).toBe('shared');
  });

  it('an unstamped row with no origin is private', () => {
    expect(jobRoomAudience({})).toBe('private');
  });
});
