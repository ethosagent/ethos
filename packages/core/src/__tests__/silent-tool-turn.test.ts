// V-CP-1 — a turn that does its work through tools and then stops without a
// word is a SUCCESS. `settleTextEnd` (agent-loop/stages/text-end.ts) raises
// `empty_completion` only when the cap cut the reply off or no tool ran at all.
// These drive a real AgentLoop through the same drain logic as the two
// consumers that treat `error` as failure: the dream executor
// (extensions/gateway/src/dream-executor.ts, success = `done` with no `error`
// before it) and delegate_task (extensions/tools-delegation/src/index.ts
// `runSubAgent`, which throws on `error`).

import type { AgentEvent, CompletionChunk, LLMProvider, Message, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** First call asks for `toolName`; the call after its result ends with no text. */
function silentAfterToolLLM(toolName: string): LLMProvider {
  return {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages.at(-1);
      const afterTool =
        last !== undefined &&
        typeof last.content !== 'string' &&
        JSON.stringify(last.content).includes('tool_result');
      if (!afterTool) {
        const args = JSON.stringify({ content: 'fact' });
        yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
        yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: args };
        yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: args };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function recordingTool(name: string, calls: unknown[]): Tool {
  return {
    name,
    description: name,
    schema: { type: 'object' },
    capabilities: {},
    async execute(args: unknown) {
      calls.push(args);
      return { ok: true, value: 'written' };
    },
  };
}

function loopWith(toolName: string, calls: unknown[]): AgentLoop {
  const tools = new DefaultToolRegistry();
  tools.register(recordingTool(toolName, calls));
  return new AgentLoop({
    llm: silentAfterToolLLM(toolName),
    tools,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
    compaction: { autoCompact: false },
  });
}

describe('V-CP-1 — a silent tool-only turn ends with a normal done', () => {
  it('dream-executor-like consumer: a memory_write then silence counts as success', async () => {
    const calls: unknown[] = [];
    let errored = false;
    let success = false;
    for await (const event of loopWith('memory_write', calls).run('dream', {
      sessionKey: 'dream:p:1',
    })) {
      if (event.type === 'error') errored = true;
      else if (event.type === 'done' && !errored) success = true;
    }
    expect(calls).toEqual([{ content: 'fact' }]);
    expect(errored).toBe(false);
    expect(success).toBe(true);
  });

  it('delegate_task-like consumer: a sub-agent that finished via tools does not throw', async () => {
    const calls: unknown[] = [];
    const run = async (): Promise<string> => {
      let output = '';
      let failure: string | undefined;
      for await (const event of loopWith('write_file', calls).run('do it', {
        sessionKey: 'sub:1',
      })) {
        if (event.type === 'text_delta') output += event.text;
        else if (event.type === 'error') failure = event.error;
        else if (event.type === 'done') output += event.text;
      }
      if (failure !== undefined) throw new Error(failure);
      return output.trim();
    };
    await expect(run()).resolves.toBe('');
    expect(calls).toHaveLength(1);
  });

  it('the done follows the tool events, with no error anywhere', async () => {
    const events: AgentEvent[] = [];
    for await (const e of loopWith('side', []).run('go', { sessionKey: 'cli:silent' })) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types).not.toContain('error');
    expect(types.indexOf('done')).toBeGreaterThan(types.indexOf('tool_end'));
  });
});
