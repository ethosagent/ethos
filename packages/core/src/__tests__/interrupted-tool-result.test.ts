import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { INTERRUPTED_TOOL_RESULT } from '../agent-loop/history';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

// Pins the mirror guard's text (durable-background-jobs D5): the only writer of
// INTERRUPTED_TOOL_RESULT is agent-loop/history.ts, and it is never persisted.

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

function capturingLLM(captured: Message[][]): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      captured.push(messages);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

describe('interrupted tool result text', () => {
  it('is the exact wording that tells the model the call may have had an effect', () => {
    expect(INTERRUPTED_TOOL_RESULT).toBe(
      '[interrupted — the process stopped while this call ran; it may or may not have taken effect. Check its effect before repeating it.]',
    );
  });

  it('fills every gap with it, then keeps the new prompt as its own user message', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:interrupted-text',
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: { ...zeroUsage },
    });
    await session.appendMessage({ sessionId: s.id, role: 'user', content: 'do the thing' });
    await session.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'on it',
      toolCalls: [
        { id: 'tcA', name: 'read_file', input: { path: '/a.txt' } },
        { id: 'tcB', name: 'read_file', input: { path: '/b.txt' } },
      ],
    });

    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: capturingLLM(captured),
      session,
      safety: createTestSafety(),
    });
    for await (const _ of loop.run('continue', {
      sessionKey: 'cli:interrupted-text',
      roomAudience: 'private',
    })) {
      // drain to exhaustion
    }

    const messages = captured[0] ?? [];
    const idx = messages.findIndex(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_use'),
    );
    expect(idx).toBeGreaterThanOrEqual(0);

    const results = messages[idx + 1];
    expect(results?.role).toBe('user');
    const blocks = Array.isArray(results?.content) ? results.content : [];
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b.type).toBe('tool_result');
      if (b.type !== 'tool_result') continue;
      expect(b.is_error).toBe(true);
      expect(b.content).toBe(INTERRUPTED_TOOL_RESULT);
    }

    // Two user messages in a row: the results, then the new prompt.
    const prompt = messages[idx + 2];
    expect(prompt?.role).toBe('user');
    const text =
      typeof prompt?.content === 'string'
        ? prompt.content
        : (prompt?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('continue');
  });
});
