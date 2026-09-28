// UBP-001 / D1 — a steer that lands while the model is writing a text-only
// answer used to be acked "↩ noted" and then dropped: the only drain was the
// tool seam, and a text-only turn has none. AgentLoop now drains the sink on
// `text-end` and runs one more LLM call, so the steer reaches the model and the
// answer. UBP-012 — a steer entry can carry image/document blocks, and both
// seams send them.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  MessageContent,
  ProviderCapabilities,
  SteerEntry,
  SteerSink,
  StoredMessage,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { toLLMMessages } from '../agent-loop/history';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { makeTool } from './golden/scripted-llm';
import { createTestSafety } from './helpers/test-safety';

/** Array-backed sink with the optional UBP-012 entry methods. */
class TestSink implements SteerSink {
  private q: SteerEntry[] = [];
  push(text: string): boolean {
    this.q.push({ text });
    return true;
  }
  pushEntry(entry: SteerEntry): boolean {
    this.q.push(entry);
    return true;
  }
  drain(): string[] {
    return this.drainEntries().map((e) => e.text);
  }
  drainEntries(): SteerEntry[] {
    const out = this.q;
    this.q = [];
    return out;
  }
  depth(): number {
    return this.q.length;
  }
}

/** A text-only legacy sink: no pushEntry / drainEntries. */
class LegacySink implements SteerSink {
  private q: string[] = [];
  push(text: string): boolean {
    this.q.push(text);
    return true;
  }
  drain(): string[] {
    const out = this.q;
    this.q = [];
    return out;
  }
  depth(): number {
    return this.q.length;
  }
}

interface Script {
  text?: string;
  toolCalls?: Array<{ id: string; name: string }>;
  /** Runs after the first text delta — "the user sends a message mid-stream". */
  midStream?: () => void;
}

function scriptedLLM(
  script: Script[],
  captured: Message[][],
  capabilities?: ProviderCapabilities,
): LLMProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    ...(capabilities ? { capabilities } : {}),
    async *complete(messages: Message[]): AsyncGenerator<CompletionChunk> {
      captured.push(JSON.parse(JSON.stringify(messages)));
      const step = script[i++] ?? { text: 'extra' };
      if (step.text) yield { type: 'text_delta', text: step.text };
      step.midStream?.();
      for (const tc of step.toolCalls ?? []) {
        yield { type: 'tool_use_start', toolCallId: tc.id, toolName: tc.name };
        yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: '{}' };
      }
      yield {
        type: 'done',
        finishReason: step.toolCalls && step.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      };
    },
    async countTokens() {
      return 1;
    },
  };
}

const VISION: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  visionImages: true,
  visionDocuments: true,
  thinking: false,
  promptCaching: false,
  cacheBreakpoints: false,
  systemPromptStyle: 'top-level',
  tokenCounting: 'estimated',
  contractVersion: 1,
};

const IMAGE: Extract<MessageContent, { type: 'image' }> = {
  type: 'image',
  mediaType: 'image/png',
  data: 'aGVsbG8=',
  filename: 'shot2.png',
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function textOf(messages: Message[] | undefined): string {
  return JSON.stringify(messages ?? []);
}

function doneText(events: AgentEvent[]): string | undefined {
  const done = events.find((e) => e.type === 'done');
  return done?.type === 'done' ? done.text : undefined;
}

describe('UBP-001 — a steer during a text-only turn reaches the model', () => {
  it('drains on text-end and runs one more LLM call whose answer ends the turn', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [
          { text: 'Paris is the capital of France.', midStream: () => sink.push('and Germany?') },
          { text: 'Berlin is the capital of Germany.' },
        ],
        captured,
      ),
      session,
      safety: createTestSafety(),
    });

    const events = await collect(
      loop.run("what's the capital of France?", { sessionKey: 'cli:steer', steerSink: sink }),
    );

    expect(captured).toHaveLength(2);
    // The second call carries the first answer, then the steer as a user message.
    const second = captured[1] ?? [];
    expect(second.at(-2)).toEqual({
      role: 'assistant',
      content: 'Paris is the capital of France.',
    });
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[USER STEER]: and Germany?' }],
    });
    // One reply, both answers; no error.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(doneText(events)).toBe(
      'Paris is the capital of France.\n\nBerlin is the capital of Germany.',
    );
    // The streamed deltas add up to the same reply the done event carries.
    const streamed = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(streamed).toBe(doneText(events));
    expect(sink.depth()).toBe(0);

    // Persisted as a user_steer row, between the two assistant rows.
    const { id } = (await session.getSessionByKey('cli:steer')) ?? { id: '' };
    const rows = await session.getMessages(id);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'user_steer', 'assistant']);
    expect(rows[2]?.content).toBe('and Germany?');
  });

  it('works with a legacy text-only sink (no drainEntries)', async () => {
    const sink = new LegacySink();
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [{ text: 'one', midStream: () => sink.push('two?') }, { text: 'two' }],
        captured,
      ),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    await collect(loop.run('q', { sessionKey: 'cli:legacy', steerSink: sink }));
    expect(captured).toHaveLength(2);
    expect(textOf(captured[1])).toContain('[USER STEER]: two?');
  });

  it('a steer during the LAST call of a tool-using turn (after the tool seam) is not lost', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const tools = new DefaultToolRegistry();
    tools.register(makeTool('side', 'side-value'));
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [
          { text: 'checking', toolCalls: [{ id: 'tc1', name: 'side' }] },
          { text: 'done checking.', midStream: () => sink.push('also check the logs') },
          { text: 'logs look fine.' },
        ],
        captured,
      ),
      tools,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    const events = await collect(loop.run('go', { sessionKey: 'cli:last', steerSink: sink }));
    expect(captured).toHaveLength(3);
    expect(textOf(captured[2])).toContain('[USER STEER]: also check the logs');
    expect(doneText(events)).toContain('logs look fine.');
  });

  it('no steer → exactly one LLM call, unchanged', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM([{ text: 'hi' }], captured),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    const events = await collect(loop.run('q', { sessionKey: 'cli:none', steerSink: sink }));
    expect(captured).toHaveLength(1);
    expect(doneText(events)).toBe('hi');
  });

  it('respects the iteration budget: on the last allowed iteration the steer stays queued', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM([{ text: 'only', midStream: () => sink.push('late') }], captured),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      options: { maxIterations: 1 },
    });
    await collect(loop.run('q', { sessionKey: 'cli:budget', steerSink: sink }));
    expect(captured).toHaveLength(1);
    // Left for the surface to report (the CLI prints STEER_DISCARDED_NOTICE).
    expect(sink.depth()).toBe(1);
  });

  it('respects abort: an aborted turn does not run another call for the steer', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const controller = new AbortController();
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [
          {
            text: 'partial',
            midStream: () => {
              sink.push('more');
              controller.abort();
            },
          },
        ],
        captured,
      ),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    await collect(
      loop.run('q', {
        sessionKey: 'cli:abort',
        steerSink: sink,
        abortSignal: controller.signal,
      }),
    );
    expect(captured).toHaveLength(1);
  });

  it('replays a text-end steer as a user message on the next turn', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [{ text: 'A.', midStream: () => sink.push('and B?') }, { text: 'B.' }, { text: 'C.' }],
        captured,
      ),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    await collect(loop.run('q1', { sessionKey: 'cli:replay', steerSink: sink }));
    await collect(loop.run('q2', { sessionKey: 'cli:replay', steerSink: sink }));
    const third = captured[2] ?? [];
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(third[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[USER STEER]: and B?' }],
    });
  });
});

describe('UBP-012 — a steer entry carries attachment blocks', () => {
  it('text-end seam: the image block reaches the model with the steer text', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [
          {
            text: 'Looking at screenshot 1.',
            midStream: () => sink.pushEntry({ text: '(attached image)', blocks: [IMAGE] }),
          },
          { text: 'Comparing both.' },
        ],
        captured,
        VISION,
      ),
      session,
      safety: createTestSafety(),
    });
    await collect(loop.run('compare these', { sessionKey: 'cli:img', steerSink: sink }));
    expect(captured[1]?.at(-1)).toEqual({
      role: 'user',
      content: [IMAGE, { type: 'text', text: '[USER STEER]: (attached image)' }],
    });
    const { id } = (await session.getSessionByKey('cli:img')) ?? { id: '' };
    const steerRow = (await session.getMessages(id)).find((r) => r.role === 'user_steer');
    expect(steerRow?.contentBlocks).toEqual([IMAGE]);
  });

  it('tool seam: the image block is appended to the tool_results message', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const tools = new DefaultToolRegistry();
    tools.register(makeTool('side', 'side-value'));
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [
          {
            text: 'checking',
            toolCalls: [{ id: 'tc1', name: 'side' }],
            midStream: () => sink.pushEntry({ text: 'second screenshot', blocks: [IMAGE] }),
          },
          { text: 'ok' },
        ],
        captured,
        VISION,
      ),
      tools,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    await collect(loop.run('go', { sessionKey: 'cli:img-tool', steerSink: sink }));
    const batch = captured[1]?.at(-1);
    expect(batch?.role).toBe('user');
    const blocks = Array.isArray(batch?.content) ? batch.content : [];
    expect(blocks[0]?.type).toBe('tool_result');
    expect(blocks.slice(1)).toEqual([
      IMAGE,
      { type: 'text', text: '[USER STEER]: second screenshot' },
    ]);
  });

  it('a model without vision gets a line naming the attachment, not the bytes', async () => {
    const sink = new TestSink();
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM(
        [
          { text: 'one', midStream: () => sink.pushEntry({ text: 'look', blocks: [IMAGE] }) },
          { text: 'two' },
        ],
        captured,
      ),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    await collect(loop.run('q', { sessionKey: 'cli:novision', steerSink: sink }));
    const last = captured[1]?.at(-1);
    expect(textOf([last as Message])).not.toContain('aGVsbG8=');
    expect(last).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[USER STEER]: look\n[image attached: shot2.png — not sent, this model cannot read images]',
        },
      ],
    });
  });

  it('history replay keeps a text-end steer’s blocks', () => {
    const at = new Date(0);
    const rows: StoredMessage[] = [
      { id: '1', sessionId: 's', role: 'user', content: 'q', timestamp: at },
      { id: '2', sessionId: 's', role: 'assistant', content: 'A.', timestamp: at },
      {
        id: '3',
        sessionId: 's',
        role: 'user_steer',
        content: 'see this',
        contentBlocks: [IMAGE],
        timestamp: at,
      },
      { id: '4', sessionId: 's', role: 'assistant', content: 'B.', timestamp: at },
    ];
    expect(toLLMMessages(rows)[2]).toEqual({
      role: 'user',
      content: [IMAGE, { type: 'text', text: '[USER STEER]: see this' }],
    });
  });
});
