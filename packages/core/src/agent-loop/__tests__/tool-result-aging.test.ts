// Phase 1a — tool-result aging (assembled view only).

import type { Message, MessageContent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  advanceAgingState,
  applyAgingToView,
  DEFAULT_AGING_STATE,
  SOFT_TRIM_KEEP_CHARS,
} from '../tool-result-aging';

// Build a history of `turns` tool-using turns: each is an assistant message
// with a tool_use, followed by a user message with the matching tool_result.
function toolConversation(turns: number, resultChars: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    const id = `call-${i}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'read_file', input: { i } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'R'.repeat(resultChars) }],
    });
  }
  return messages;
}

function toolResults(messages: Message[]): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ id: b.tool_use_id, content: b.content });
    }
  }
  return out;
}

describe('advanceAgingState — threshold crossings', () => {
  it('does nothing below the 0.3 soft ratio', () => {
    const msgs = toolConversation(10, 5000);
    const { state, changed } = advanceAgingState(DEFAULT_AGING_STATE, msgs, 0.2);
    expect(changed).toBe(false);
    expect(state.level).toBe('none');
  });

  it('crosses to soft at ratio ≥ 0.3 and soft-trims OLD tool results', () => {
    const msgs = toolConversation(10, 5000);
    const { state, changed } = advanceAgingState(DEFAULT_AGING_STATE, msgs, 0.35);
    expect(changed).toBe(true);
    expect(state.level).toBe('soft');
    // 10 turns, keep last 3 → 7 aged.
    expect(state.soft).toHaveLength(7);

    const { messages } = applyAgingToView(msgs, state);
    const results = toolResults(messages);
    // Aged results shrink to head+tail keep; recent 3 stay full length.
    const trimmed = results.filter((r) => r.content.length < 5000);
    const full = results.filter((r) => r.content.length === 5000);
    expect(trimmed).toHaveLength(7);
    expect(full).toHaveLength(3);
    for (const r of trimmed) {
      expect(r.content.length).toBeLessThanOrEqual(SOFT_TRIM_KEEP_CHARS * 2 + 128);
    }
  });

  it('crosses to hard at ratio ≥ 0.5 and clears OLD tool results to a placeholder', () => {
    const msgs = toolConversation(10, 5000);
    const { state } = advanceAgingState(DEFAULT_AGING_STATE, msgs, 0.55);
    expect(state.level).toBe('hard');
    expect(state.hard).toHaveLength(7);

    const { messages } = applyAgingToView(msgs, state);
    const results = toolResults(messages);
    const cleared = results.filter((r) => r.content.startsWith('[tool result cleared'));
    expect(cleared).toHaveLength(7);
  });

  it('is monotonic — never downgrades once aged', () => {
    const msgs = toolConversation(10, 5000);
    const hard = advanceAgingState(DEFAULT_AGING_STATE, msgs, 0.6).state;
    const after = advanceAgingState(hard, msgs, 0.1);
    expect(after.changed).toBe(false);
    expect(after.state.level).toBe('hard');
  });
});

describe('aging — batched at crossings (cache stability)', () => {
  it('produces an IDENTICAL aged view for the aged region across turns in the same band', () => {
    const turnA = toolConversation(10, 5000);
    const { state } = advanceAgingState(DEFAULT_AGING_STATE, turnA, 0.35);

    // Next turn appends a new tool turn; the SAME state is reused (no crossing).
    const turnB = [
      ...turnA,
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'call-new', name: 'read_file', input: {} }],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'call-new', content: 'N'.repeat(5000) },
        ],
      },
    ];

    const viewA = applyAgingToView(turnA, state).messages;
    const viewB = applyAgingToView(turnB, state).messages;

    // The aged prefix (everything from turn A) must be byte-identical between
    // the two turns — the appended turn does not perturb it (cache holds).
    expect(JSON.stringify(viewB.slice(0, viewA.length))).toBe(JSON.stringify(viewA));
    // And the freshly-appended result is untouched.
    const newResult = toolResults(viewB).find((r) => r.id === 'call-new');
    expect(newResult?.content).toBe('N'.repeat(5000));
  });
});

describe('aging — property: never splits a tool_use / tool_result pair', () => {
  it('every tool_use still has a matching tool_result after aging, at every level', () => {
    for (const ratio of [0.35, 0.55]) {
      const msgs = toolConversation(12, 4000);
      const { state } = advanceAgingState(DEFAULT_AGING_STATE, msgs, ratio);
      const { messages } = applyAgingToView(msgs, state);

      const useIds = new Set<string>();
      const resultIds = new Set<string>();
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content as MessageContent[]) {
          if (b.type === 'tool_use') useIds.add(b.id);
          if (b.type === 'tool_result') resultIds.add(b.tool_use_id);
        }
      }
      // Same count in, same count out (no message removed / pair split).
      expect(messages).toHaveLength(msgs.length);
      expect([...useIds].sort()).toEqual([...resultIds].sort());
    }
  });
});
