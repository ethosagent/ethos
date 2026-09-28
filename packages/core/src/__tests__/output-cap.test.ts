// UBP-020 — a turn that ends with no reply text and no error used to reach the
// surface as a blank `done`, and the gateway delivered nothing at all. It now
// ends with an `error` event (code `empty_completion`), not a new AgentEvent
// variant — when the cap cut the reply off, or when no tool ran either. A turn
// that did its work through tools and then stopped silently still ends with a
// blank `done` (V-CP-1); the gateway turns that into EMPTY_REPLY_NOTICE. UBP-033 — a `max_tokens` stop is visible: a reply cut off at the cap
// gets a user-audience `_loop` notice, and a tool call whose arguments the cap
// cut off is rejected with a cap-specific reason instead of "malformed".

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { MAX_TOKENS_REPLY_NOTICE, MAX_TOKENS_TOOL_REJECTION } from '../agent-loop/output-cap';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

interface Step {
  text?: string;
  /** Raw argument JSON per call — may be truncated. */
  toolCalls?: Array<{ id: string; name: string; json: string; end?: boolean }>;
  finishReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

function llmOf(steps: Step[], captured: Message[][]): LLMProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncGenerator<CompletionChunk> {
      captured.push(JSON.parse(JSON.stringify(messages)));
      const step = steps[i++] ?? { text: 'fallback', finishReason: 'end_turn' };
      if (step.text) yield { type: 'text_delta', text: step.text };
      for (const tc of step.toolCalls ?? []) {
        yield { type: 'tool_use_start', toolCallId: tc.id, toolName: tc.name };
        yield { type: 'tool_use_delta', toolCallId: tc.id, partialJson: tc.json };
        if (tc.end !== false) yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: '' };
      }
      yield { type: 'done', finishReason: step.finishReason };
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
    async execute(args: unknown): Promise<ToolResult> {
      calls.push(args);
      return { ok: true, value: 'written' };
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function toolResultsOf(
  messages: Message[] | undefined,
): Array<{ content: string; is_error?: boolean }> {
  const out: Array<{ content: string; is_error?: boolean }> = [];
  for (const m of messages ?? []) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ content: b.content, is_error: b.is_error });
    }
  }
  return out;
}

function loop(steps: Step[], captured: Message[][], tools?: DefaultToolRegistry): AgentLoop {
  return new AgentLoop({
    llm: llmOf(steps, captured),
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
    ...(tools ? { tools } : {}),
  });
}

describe('UBP-020 — an empty final answer is surfaced, not a blank done', () => {
  it('no text at all → error empty_completion and no done', async () => {
    const events = await collect(
      loop([{ finishReason: 'end_turn' }], []).run('hi', { sessionKey: 'cli:empty' }),
    );
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('empty_completion');
    expect(err?.type === 'error' && err.error).toBe('The model finished without writing a reply.');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('max_tokens with empty text → error empty_completion naming the output cap', async () => {
    const events = await collect(
      loop([{ finishReason: 'max_tokens' }], []).run('hi', { sessionKey: 'cli:empty-cap' }),
    );
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('empty_completion');
    expect(err?.type === 'error' && err.error).toMatch(/output token limit/);
  });

  it('silent after a tool call → a blank done, not an error (V-CP-1); a preamble is the reply', async () => {
    const calls: unknown[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(recordingTool('side', calls));
    const bare = await collect(
      loop(
        [
          { toolCalls: [{ id: 't1', name: 'side', json: '{}' }], finishReason: 'tool_use' },
          { finishReason: 'end_turn' },
        ],
        [],
        tools,
      ).run('go', { sessionKey: 'cli:empty-tool' }),
    );
    // The work was done through the tool; the turn succeeded without words.
    expect(calls).toEqual([{}]);
    expect(bare.some((e) => e.type === 'error')).toBe(false);
    expect(bare.find((e) => e.type === 'done')).toMatchObject({ text: '' });

    const withPreamble = await collect(
      loop(
        [
          {
            text: 'Checking now.',
            toolCalls: [{ id: 't1', name: 'side', json: '{}' }],
            finishReason: 'tool_use',
          },
          { finishReason: 'end_turn' },
        ],
        [],
        tools,
      ).run('go', { sessionKey: 'cli:preamble' }),
    );
    expect(withPreamble.some((e) => e.type === 'error')).toBe(false);
    expect(withPreamble.find((e) => e.type === 'done')).toMatchObject({ text: 'Checking now.' });
  });

  it('max_tokens with no text after a tool call → still error empty_completion', async () => {
    const tools = new DefaultToolRegistry();
    tools.register(recordingTool('side', []));
    const events = await collect(
      loop(
        [
          { toolCalls: [{ id: 't1', name: 'side', json: '{}' }], finishReason: 'tool_use' },
          { finishReason: 'max_tokens' },
        ],
        [],
        tools,
      ).run('go', { sessionKey: 'cli:empty-tool-cap' }),
    );
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'empty_completion' });
    expect(err?.type === 'error' && err.error).toMatch(/output token limit/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('UBP-033 — a max_tokens stop is visible', () => {
  it('a reply cut off at the cap gets a user-audience _loop notice before done', async () => {
    const events = await collect(
      loop([{ text: '1, 2, 3, 4', finishReason: 'max_tokens' }], []).run('count', {
        sessionKey: 'cli:cut',
      }),
    );
    const noticeIdx = events.findIndex(
      (e) => e.type === 'tool_progress' && e.toolName === '_loop' && e.audience === 'user',
    );
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    expect(events[noticeIdx]).toMatchObject({ message: MAX_TOKENS_REPLY_NOTICE });
    expect(doneIdx).toBeGreaterThan(noticeIdx);
  });

  it('a finished reply gets no notice', async () => {
    const events = await collect(
      loop([{ text: 'done.', finishReason: 'end_turn' }], []).run('q', { sessionKey: 'cli:ok' }),
    );
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_loop')).toBe(false);
  });

  it('a tool call cut off at the cap is rejected with the cap reason, not "malformed"', async () => {
    const calls: unknown[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(recordingTool('write_file', calls));
    const captured: Message[][] = [];
    await collect(
      loop(
        [
          {
            toolCalls: [{ id: 't1', name: 'write_file', json: '{"path":"a.txt","content":"par' }],
            finishReason: 'max_tokens',
          },
          { text: 'I will split it.', finishReason: 'end_turn' },
        ],
        captured,
        tools,
      ).run('write it', { sessionKey: 'cli:cut-tool' }),
    );
    // Not executed — not even with "repaired" (closed-up, truncated) arguments.
    expect(calls).toEqual([]);
    const [result] = toolResultsOf(captured[1]);
    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain(MAX_TOKENS_TOOL_REJECTION);
    expect(result?.content).not.toContain('malformed');
  });

  it('a call whose stream never closed still gets a tool_result with the cap reason', async () => {
    const tools = new DefaultToolRegistry();
    tools.register(recordingTool('write_file', []));
    const captured: Message[][] = [];
    await collect(
      loop(
        [
          {
            toolCalls: [{ id: 't1', name: 'write_file', json: '{"path":"a', end: false }],
            finishReason: 'max_tokens',
          },
          { text: 'ok', finishReason: 'end_turn' },
        ],
        captured,
        tools,
      ).run('write it', { sessionKey: 'cli:cut-open' }),
    );
    expect(toolResultsOf(captured[1])[0]?.content).toContain(MAX_TOKENS_TOOL_REJECTION);
  });

  it('a complete call at a max_tokens stop still runs', async () => {
    const calls: unknown[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(recordingTool('write_file', calls));
    await collect(
      loop(
        [
          {
            toolCalls: [{ id: 't1', name: 'write_file', json: '{"path":"a.txt"}' }],
            finishReason: 'max_tokens',
          },
          { text: 'ok', finishReason: 'end_turn' },
        ],
        [],
        tools,
      ).run('write it', { sessionKey: 'cli:cut-complete' }),
    );
    expect(calls).toEqual([{ path: 'a.txt' }]);
  });
});
