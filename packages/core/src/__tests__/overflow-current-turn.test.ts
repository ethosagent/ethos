// UBP-021 — tool results piled up inside ONE turn used to be untouchable on a
// context overflow: emergency compaction only shrinks history OLDER than the
// current turn, so a fresh session that read five large files in one turn
// failed with `context_overflow` and lost the answer for the work already done.
// The overflow retry now also soft-trims this turn's earlier tool results
// (never the latest batch), keeping every tool_use/tool_result pair intact.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  MessageContent,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { trimCurrentTurnToolResults } from '../agent-loop/overflow';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const RESULT_CHARS = 20_000;

function bigTool(): Tool {
  return {
    name: 'read_big',
    description: 'returns a large file',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'x'.repeat(RESULT_CHARS) };
    },
  };
}

/**
 * Asks for `reads` sequential tool calls (one per LLM call), then answers.
 * Throws the Anthropic overflow error whenever the request is larger than
 * `limitChars`, like a provider whose window the pile of results outgrew.
 */
function overflowingLLM(
  reads: number,
  limitChars: number,
): { llm: LLMProvider; captured: Message[][]; overflows: () => number } {
  const captured: Message[][] = [];
  let overflows = 0;
  let served = 0;
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncGenerator<CompletionChunk> {
      if (JSON.stringify(messages).length > limitChars) {
        overflows++;
        throw new Error('400 invalid_request_error: prompt is too long: 250000 tokens > 200000');
      }
      captured.push(JSON.parse(JSON.stringify(messages)));
      if (served < reads) {
        served++;
        const id = `read-${served}`;
        yield { type: 'tool_use_start', toolCallId: id, toolName: 'read_big' };
        // Distinct args, so the identical-call loop guard stays out of it.
        yield { type: 'tool_use_end', toolCallId: id, inputJson: JSON.stringify({ n: served }) };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'survey complete' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, captured, overflows: () => overflows };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function toolResults(messages: Message[]): Extract<MessageContent, { type: 'tool_result' }>[] {
  return messages.flatMap((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? m.content.filter(
          (b): b is Extract<MessageContent, { type: 'tool_result' }> => b.type === 'tool_result',
        )
      : [],
  );
}

function makeLoop(llm: LLMProvider): AgentLoop {
  const tools = new DefaultToolRegistry();
  tools.register(bigTool());
  return new AgentLoop({
    llm,
    tools,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
}

describe('UBP-021 — overflow inside one turn trims that turn’s earlier tool results', () => {
  it('a fresh turn with five large results completes after the retry', async () => {
    const { llm, captured, overflows } = overflowingLLM(5, 90_000);
    const events = await collect(makeLoop(llm).run('survey the repo', { sessionKey: 'cli:fresh' }));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ text: 'survey complete' });
    expect(overflows()).toBeGreaterThanOrEqual(1);

    const last = captured.at(-1) ?? [];
    const results = toolResults(last);
    // Every tool_use still has its tool_result; the latest one is verbatim.
    expect(results).toHaveLength(5);
    expect(results.at(-1)?.content).toContain('x'.repeat(RESULT_CHARS));
    // Earlier ones were soft-trimmed.
    expect(results.slice(0, -1).every((r) => r.content.length < RESULT_CHARS)).toBe(true);
    // The user's question survived.
    expect(JSON.stringify(last)).toContain('survey the repo');
  });

  it('a turn that overflows twice recovers twice (each retry follows progress)', async () => {
    const { llm, overflows } = overflowingLLM(6, 70_000);
    const events = await collect(makeLoop(llm).run('survey', { sessionKey: 'cli:twice' }));
    expect(overflows()).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ text: 'survey complete' });
  });

  it('when even the trimmed turn cannot fit, the overflow error still surfaces', async () => {
    const { llm } = overflowingLLM(2, 15_000);
    const events = await collect(makeLoop(llm).run('survey', { sessionKey: 'cli:hopeless' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');
  });
});

describe('trimCurrentTurnToolResults', () => {
  const big = 'y'.repeat(10_000);
  const turn: Message[] = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'survey' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: big }] },
  ];

  it('trims the current turn’s results except the latest batch; nothing is removed', () => {
    const out = trimCurrentTurnToolResults(turn);
    expect(out).toBeDefined();
    expect(out).toHaveLength(turn.length);
    const [a, b] = toolResults(out ?? []);
    expect(a?.tool_use_id).toBe('a');
    expect(a?.content.length).toBeLessThan(big.length);
    expect(b?.content).toBe(big);
  });

  it('returns undefined when there is nothing to trim', () => {
    expect(trimCurrentTurnToolResults(turn.slice(0, 5))).toBeUndefined();
  });
});
