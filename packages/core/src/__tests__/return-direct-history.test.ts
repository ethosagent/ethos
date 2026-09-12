// A `returnDirect` tool's result IS the turn's answer: processTools yields
// `done` with it and the LLM never writes a reply. That answer has to be in
// the session history too, as the assistant message it is — otherwise a
// surface rebuilding from history (web chat after reload) has no answer to
// show, and the next turn's LLM request goes tool_result → user with the reply
// the user actually saw missing from the conversation.

import {
  type AgentEvent,
  type Message,
  type MessageContent,
  RETURNED_DIRECT_TOOL_RESULT,
  type Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { EMPTY_ASSISTANT_TEXT } from '../agent-loop/history';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { type CapturedCall, makeScriptedLLM, makeTool } from './golden/scripted-llm';
import { createTestSafety } from './helpers/test-safety';

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function doneText(events: AgentEvent[]): string | undefined {
  const done = events.find((e) => e.type === 'done');
  return done?.type === 'done' ? done.text : undefined;
}

/** A loop with one returnDirect tool `quick` answering `answer`, plus `extra`. */
function directLoop(
  steps: Parameters<typeof makeScriptedLLM>[0],
  answer: string,
  extra: Tool[] = [],
) {
  const captured: CapturedCall[] = [];
  const tools = new DefaultToolRegistry();
  tools.register(makeTool('quick', answer, { returnDirect: true }));
  for (const t of extra) tools.register(t);
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm: makeScriptedLLM(steps, captured),
    tools,
    session,
    safety: createTestSafety(),
  });
  return { loop, session, captured };
}

/** Both providers' contract: roles alternate, and every tool_use is answered
 *  by a tool_result in the message immediately after it. */
function expectValidProviderHistory(messages: Message[]): void {
  messages.forEach((m, i) => {
    if (i > 0)
      expect(m.role, `message ${i} repeats the previous role`).not.toBe(messages[i - 1]?.role);
    if (m.role !== 'assistant' || typeof m.content === 'string') return;
    const useIds = m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
    if (useIds.length === 0) return;
    const next = messages[i + 1]?.content;
    const resultIds = Array.isArray(next)
      ? next.flatMap((b: MessageContent) => (b.type === 'tool_result' ? [b.tool_use_id] : []))
      : [];
    expect(resultIds.sort()).toEqual([...useIds].sort());
  });
}

/** Anthropic rejects blank assistant text anywhere but the final message. */
function expectNoBlankAssistantText(messages: Message[]): void {
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') expect(m.content.trim()).not.toBe('');
    else for (const b of m.content) if (b.type === 'text') expect(b.text.trim()).not.toBe('');
  }
}

describe('returnDirect answer in the session history', () => {
  it('persists the answer as an assistant row after the tool_result, identical to done.text', async () => {
    const { loop, session } = directLoop(
      [
        {
          text: 'Let me check.',
          toolCalls: [{ id: 'tc1', name: 'quick', input: {} }],
          finishReason: 'tool_use',
        },
      ],
      'the direct answer',
    );

    const events = await drain(loop.run('use the direct tool', { sessionKey: 'cli:direct' }));

    const s = await session.getSessionByKey('cli:direct');
    const rows = s ? await session.getMessages(s.id) : [];
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    const answer = rows[3];
    expect(answer?.content).toBe('the direct answer');
    expect(answer?.content).toBe(doneText(events));
    expect(answer?.toolCalls ?? []).toEqual([]);
    // The preamble stays on the row that carried the tool call.
    expect(rows[1]?.content).toBe('Let me check.');
  });

  it("the next turn's LLM request is a valid alternating history carrying the answer", async () => {
    const { loop, captured } = directLoop(
      [
        { toolCalls: [{ id: 'tc1', name: 'quick', input: {} }], finishReason: 'tool_use' },
        { text: 'follow-up reply', finishReason: 'end_turn' },
      ],
      'the direct answer',
    );

    await drain(loop.run('use the direct tool', { sessionKey: 'cli:direct-next' }));
    await drain(loop.run('and then?', { sessionKey: 'cli:direct-next' }));

    const sent = captured[1]?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(sent[3]).toEqual({ role: 'assistant', content: 'the direct answer' });
    expect(sent[4]).toEqual({ role: 'user', content: 'and then?' });
    expectValidProviderHistory(sent);
  });

  it('carries the answer ONCE in later requests: the tool_result is a marker, the live event the value', async () => {
    const big = 'x'.repeat(20_000);
    const { loop, session, captured } = directLoop(
      [
        {
          toolCalls: [
            { id: 'tc1', name: 'quick', input: {} },
            { id: 'tc2', name: 'side', input: {} },
          ],
          finishReason: 'tool_use',
        },
        { text: 'follow-up reply', finishReason: 'end_turn' },
      ],
      big,
      [makeTool('side', 'side-value')],
    );

    const events = await drain(loop.run('use the direct tool', { sessionKey: 'cli:direct-once' }));
    await drain(loop.run('and then?', { sessionKey: 'cli:direct-once' }));

    // Live: the tool_end still reports what the tool returned.
    const end = events.find((e) => e.type === 'tool_end' && e.toolCallId === 'tc1');
    expect(end?.type === 'tool_end' ? end.result : undefined).toBe(big);

    // Persisted: the answering call's tool_result is the marker; a sibling
    // call in the same batch keeps its own result.
    const s = await session.getSessionByKey('cli:direct-once');
    const rows = s ? await session.getMessages(s.id) : [];
    const resultOf = (id: string) =>
      rows.find((r) => r.role === 'tool_result' && r.toolCallId === id);
    expect(resultOf('tc1')?.content).toBe(RETURNED_DIRECT_TOOL_RESULT);
    expect(resultOf('tc1')?.isError).toBe(false);
    expect(resultOf('tc2')?.content).toBe('side-value');

    // The next request: one copy of the answer, as the assistant message.
    const sent = captured[1]?.messages ?? [];
    expect(JSON.stringify(sent).split(big).length - 1).toBe(1);
    expect(sent[3]).toEqual({ role: 'assistant', content: big });
    expectValidProviderHistory(sent);
  });

  it('an EMPTY returnDirect value answers with the placeholder — persisted, done.text and replay agree', async () => {
    const { loop, session, captured } = directLoop(
      [
        { toolCalls: [{ id: 'tc1', name: 'quick', input: {} }], finishReason: 'tool_use' },
        { text: 'follow-up reply', finishReason: 'end_turn' },
      ],
      '',
    );

    const events = await drain(loop.run('use the direct tool', { sessionKey: 'cli:direct-empty' }));
    await drain(loop.run('and then?', { sessionKey: 'cli:direct-empty' }));

    const s = await session.getSessionByKey('cli:direct-empty');
    const rows = s ? await session.getMessages(s.id) : [];
    const answers = rows.filter((r) => r.role === 'assistant' && !r.toolCalls?.length);
    expect(answers[0]?.content).toBe(EMPTY_ASSISTANT_TEXT);
    expect(doneText(events)).toBe(EMPTY_ASSISTANT_TEXT);

    const sent = captured[1]?.messages ?? [];
    expect(sent[3]).toEqual({ role: 'assistant', content: EMPTY_ASSISTANT_TEXT });
    expectNoBlankAssistantText(sent);
    expectValidProviderHistory(sent);
  });
});

describe('an empty MODEL reply in history', () => {
  it('replays as the placeholder, never as blank assistant content', async () => {
    const captured: CapturedCall[] = [];
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: makeScriptedLLM(
        [{ finishReason: 'end_turn' }, { text: 'second reply', finishReason: 'end_turn' }],
        captured,
      ),
      session,
      safety: createTestSafety(),
    });

    await drain(loop.run('first', { sessionKey: 'cli:empty-reply' }));
    await drain(loop.run('second', { sessionKey: 'cli:empty-reply' }));

    // The row is stored as the model produced it (it carries the call's usage)…
    const s = await session.getSessionByKey('cli:empty-reply');
    const rows = s ? await session.getMessages(s.id) : [];
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'first'],
      ['assistant', ''],
      ['user', 'second'],
      ['assistant', 'second reply'],
    ]);
    // …and replayed as something a provider accepts mid-history.
    const sent = captured[1]?.messages ?? [];
    expect(sent).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: EMPTY_ASSISTANT_TEXT },
      { role: 'user', content: 'second' },
    ]);
  });
});
