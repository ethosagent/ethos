// `ToolContext.getContext`/`setContext` are a per-TURN key/value store: each
// `AgentLoop.run()` gets its own, and it lives for the whole turn.
//
// It used to be one `ContextStore` field on the loop, cleared at the start of
// every tool batch. The gateway runs concurrent lanes on one loop, so session
// B's batch wiped (and then overwrote) what session A's tools had set — and a
// value set in batch 1 of a turn was gone by batch 2 of the same turn.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

type Step =
  | {
      kind: 'tool';
      id: string;
      name: 'ctx_set' | 'ctx_get' | 'ctx_hold';
      args: object;
      waitFor?: Promise<void>;
    }
  | { kind: 'text'; text: string };

/**
 * An LLM that plays one script per run, picked by the `label:<x>` token in the
 * run's user message (labels are `\w+`). A step with `waitFor` parks that LLM call until the
 * promise settles — how the tests force two runs to interleave.
 */
function scriptedLLM(scripts: Record<string, Step[]>): LLMProvider {
  const calls = new Map<string, number>();
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      // The LAST `label:` in the history is this run's — earlier runs on the
      // same session leave theirs behind.
      const label = [...JSON.stringify(messages).matchAll(/label:(\w+)/g)].at(-1)?.[1];
      if (!label) throw new Error('no script for this run');
      const n = calls.get(label) ?? 0;
      calls.set(label, n + 1);
      const step = scripts[label]?.[n];
      if (!step) throw new Error(`script ${label} exhausted at call ${n}`);
      if (step.kind === 'text') {
        yield { type: 'text_delta', text: step.text };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      if (step.waitFor) await step.waitFor;
      yield { type: 'tool_use_start', toolCallId: step.id, toolName: step.name };
      yield { type: 'tool_use_end', toolCallId: step.id, inputJson: JSON.stringify(step.args) };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/**
 * `ctx_set` / `ctx_get` over the tool ctx's store; `onSet` observes each write.
 * `ctx_hold` sets, parks on `hold`, then reads the same key back.
 */
function contextTools(
  onSet: (value: string) => void = () => {},
  hold: Promise<void> = Promise.resolve(),
): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'ctx_hold',
    description: 'setContext, wait, getContext',
    schema: { type: 'object' },
    capabilities: {},
    async execute(args, ctx): Promise<ToolResult> {
      const { key, value } = args as { key: string; value: string };
      ctx.setContext?.(key, value);
      onSet(value);
      await hold;
      return { ok: true, value: String(ctx.getContext?.(key)) };
    },
  });
  tools.register({
    name: 'ctx_set',
    description: 'setContext',
    schema: { type: 'object' },
    capabilities: {},
    async execute(args, ctx): Promise<ToolResult> {
      const { key, value } = args as { key: string; value: string };
      ctx.setContext?.(key, value);
      onSet(value);
      return { ok: true, value: 'set' };
    },
  });
  tools.register({
    name: 'ctx_get',
    description: 'getContext',
    schema: { type: 'object' },
    capabilities: {},
    async execute(args, ctx): Promise<ToolResult> {
      const { key } = args as { key: string };
      return { ok: true, value: String(ctx.getContext?.(key)) };
    },
  });
  return tools;
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** The result a `tool_end` reported for one tool call id. */
function resultOf(events: AgentEvent[], toolCallId: string): string | undefined {
  const end = events.find((e) => e.type === 'tool_end' && e.toolCallId === toolCallId);
  return end?.type === 'tool_end' ? end.result : undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ToolContext get/setContext — one store per run()', () => {
  it('two concurrent runs on one loop keep their own values across batches', async () => {
    const aSet = deferred();
    const bSet = deferred();
    const tools = contextTools((value) => {
      if (value === 'A') aSet.resolve();
      if (value === 'B') bSet.resolve();
    });
    // A sets, then B sets (after A's write), then A reads in a LATER batch.
    const llm = scriptedLLM({
      A: [
        { kind: 'tool', id: 'a-set', name: 'ctx_set', args: { key: 'who', value: 'A' } },
        { kind: 'tool', id: 'a-get', name: 'ctx_get', args: { key: 'who' }, waitFor: bSet.promise },
        { kind: 'text', text: 'done A' },
      ],
      B: [
        {
          kind: 'tool',
          id: 'b-set',
          name: 'ctx_set',
          args: { key: 'who', value: 'B' },
          waitFor: aSet.promise,
        },
        { kind: 'tool', id: 'b-get', name: 'ctx_get', args: { key: 'who' } },
        { kind: 'text', text: 'done B' },
      ],
    });
    const loop = new AgentLoop({
      llm,
      tools,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });

    const [a, b] = await Promise.all([
      drain(loop.run('label:A', { sessionKey: 'telegram:bot:chat-a' })),
      drain(loop.run('label:B', { sessionKey: 'telegram:bot:chat-b' })),
    ]);

    expect(resultOf(a, 'a-get')).toBe('A');
    expect(resultOf(b, 'b-get')).toBe('B');
  });

  it("a concurrent run's batch cannot wipe or overwrite a value mid-batch", async () => {
    // A's tool sets, then parks until B's tool has written; B's whole batch
    // runs in that gap. Isolates cross-run sharing from per-batch clearing.
    const aSet = deferred();
    const bSet = deferred();
    const tools = contextTools((value) => {
      if (value === 'A') aSet.resolve();
      if (value === 'B') bSet.resolve();
    }, bSet.promise);
    const llm = scriptedLLM({
      A: [
        { kind: 'tool', id: 'a-hold', name: 'ctx_hold', args: { key: 'who', value: 'A' } },
        { kind: 'text', text: 'done A' },
      ],
      B: [
        {
          kind: 'tool',
          id: 'b-set',
          name: 'ctx_set',
          args: { key: 'who', value: 'B' },
          waitFor: aSet.promise,
        },
        { kind: 'text', text: 'done B' },
      ],
    });
    const loop = new AgentLoop({
      llm,
      tools,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });

    const [a] = await Promise.all([
      drain(loop.run('label:A', { sessionKey: 'telegram:bot:chat-a' })),
      drain(loop.run('label:B', { sessionKey: 'telegram:bot:chat-b' })),
    ]);

    expect(resultOf(a, 'a-hold')).toBe('A');
  });

  it('a value set in batch 1 of a turn is still readable in batch 2', async () => {
    const llm = scriptedLLM({
      T: [
        { kind: 'tool', id: 't-set', name: 'ctx_set', args: { key: 'plan', value: 'kept' } },
        { kind: 'tool', id: 't-get', name: 'ctx_get', args: { key: 'plan' } },
        { kind: 'text', text: 'done' },
      ],
    });
    const loop = new AgentLoop({
      llm,
      tools: contextTools(),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });

    const events = await drain(loop.run('label:T', { sessionKey: 'cli:one-turn' }));

    expect(resultOf(events, 't-get')).toBe('kept');
  });

  it('a new run starts with an empty store, even on the same session', async () => {
    const llm = scriptedLLM({
      first: [
        { kind: 'tool', id: 'f-set', name: 'ctx_set', args: { key: 'who', value: 'first' } },
        { kind: 'text', text: 'done' },
      ],
      second: [
        { kind: 'tool', id: 's-get', name: 'ctx_get', args: { key: 'who' } },
        { kind: 'text', text: 'done' },
      ],
    });
    const loop = new AgentLoop({
      llm,
      tools: contextTools(),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });

    await drain(loop.run('label:first', { sessionKey: 'cli:same' }));
    const events = await drain(loop.run('label:second', { sessionKey: 'cli:same' }));

    expect(resultOf(events, 's-get')).toBe('undefined');
  });
});
